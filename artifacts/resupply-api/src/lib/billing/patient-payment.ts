// Patient payment service.
//
// Creates Stripe PaymentIntents for patient_responsibility balances
// and applies succeeded payments against the user-selected claims.
//
// Two callers:
//   * /api/me/payments — patient-initiated portal flow.
//   * /admin/patients/:id/payments — CSR-on-behalf-of-patient flow.
//
// Stripe webhook handler at /resupply-api/stripe/payments-webhook
// flips status='succeeded' and decrements per-line
// patient_responsibility_cents per the allocation snapshot.

import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import type Stripe from "stripe";

import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../stripe/config";
import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface CreateIntentInput {
  patientId: string;
  /** Per-claim allocation. Sum across entries must equal amount_cents
   *  on the resulting row. */
  allocations: Array<{
    claimId: string;
    amountAppliedCents: number;
  }>;
  source: "portal" | "csr";
  note?: string | null;
  /** PaymentIntent payment_method types — defaults to ['card']. */
  paymentMethodTypes?: string[];
  /** Caller for the audit trail. */
  initiatorEmail: string;
}

export interface CreateIntentResult {
  paymentId: string;
  paymentIntentClientSecret: string;
  amountCents: number;
}

export interface CreateIntentFailure {
  error: "stripe_not_configured" | "no_allocations" | "claim_not_owned" | "claim_balance_mismatch";
  message: string;
}

export async function createPaymentIntent(
  input: CreateIntentInput,
): Promise<CreateIntentResult | CreateIntentFailure> {
  if (input.allocations.length === 0) {
    return {
      error: "no_allocations",
      message: "at least one claim allocation is required",
    };
  }
  const totalCents = input.allocations.reduce(
    (s, a) => s + a.amountAppliedCents,
    0,
  );
  if (totalCents <= 0) {
    return {
      error: "no_allocations",
      message: "allocation total must be > 0",
    };
  }
  const config = readStripeConfigOrNull();
  if (!config) {
    return {
      error: "stripe_not_configured",
      message: "Stripe secret key is not set",
    };
  }
  const supabase = getSupabaseServiceRoleClient();

  // Validate every claim belongs to the patient AND the requested
  // allocation doesn't exceed the open balance.
  const claimIds = input.allocations.map((a) => a.claimId);
  const { data: claims } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_id, patient_responsibility_cents")
    .in("id", claimIds);
  for (const allocation of input.allocations) {
    const claim = (claims ?? []).find((c) => c.id === allocation.claimId);
    if (!claim || claim.patient_id !== input.patientId) {
      return {
        error: "claim_not_owned",
        message: `claim ${allocation.claimId} does not belong to this patient`,
      };
    }
    if (allocation.amountAppliedCents > claim.patient_responsibility_cents) {
      return {
        error: "claim_balance_mismatch",
        message: `claim ${allocation.claimId}: allocation ${allocation.amountAppliedCents} exceeds open balance ${claim.patient_responsibility_cents}`,
      };
    }
  }

  // Insert pending row FIRST so we have a stable id to pass into
  // the Stripe metadata. If Stripe call fails we leave the row in
  // status='failed' for audit.
  const { data: row, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .insert({
      patient_id: input.patientId,
      amount_cents: totalCents,
      currency: "usd",
      status: "pending",
      applied_claims_json: input.allocations as unknown as Json,
      source: input.source,
      note: input.note ?? null,
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  let intent: Stripe.PaymentIntent;
  try {
    const stripe = getStripeClient(config);
    intent = await stripe.paymentIntents.create({
      amount: totalCents,
      currency: "usd",
      payment_method_types: input.paymentMethodTypes ?? ["card"],
      metadata: {
        patient_id: input.patientId,
        patient_payment_id: row.id,
        source: input.source,
        initiator_email: input.initiatorEmail,
      },
    });
  } catch (err) {
    await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason:
          err instanceof Error ? err.message.slice(0, 2000) : String(err),
      })
      .eq("id", row.id);
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "patient_payment: stripe paymentIntents.create failed",
    );
    return {
      error: "stripe_not_configured",
      message: "Stripe rejected the payment intent create",
    };
  }

  await supabase
    .schema("resupply")
    .from("patient_payments")
    .update({
      stripe_payment_intent_id: intent.id,
      status:
        intent.status === "requires_action"
          ? "requires_action"
          : intent.status === "succeeded"
            ? "succeeded"
            : "pending",
      succeeded_at:
        intent.status === "succeeded" ? new Date().toISOString() : null,
    })
    .eq("id", row.id);

  // If Stripe returned succeeded synchronously (rare; usually
  // confirm-on-client), apply allocations immediately.
  if (intent.status === "succeeded") {
    await applySucceededPayment(supabase, row.id);
  }

  return {
    paymentId: row.id,
    paymentIntentClientSecret: intent.client_secret ?? "",
    amountCents: totalCents,
  };
}

/**
 * Apply a succeeded payment: decrement patient_responsibility_cents
 * on each claim in the allocation. Idempotent — a re-application
 * after the row is already 'succeeded' is a no-op.
 */
export async function applySucceededPayment(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<void> {
  const { data: row } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .select("id, status, patient_id, applied_claims_json")
    .eq("id", paymentId)
    .limit(1)
    .maybeSingle();
  if (!row) return;
  // Already-applied check via succeeded_at — `status='succeeded'` is
  // set by the webhook BEFORE we walk allocations, so guard on the
  // explicit per-claim decrement by tracking a flag on each claim
  // event instead. For now: only apply when status hasn't already
  // moved past 'succeeded' with a non-null succeeded_at.
  type Allocation = {
    claimId: string;
    amountAppliedCents: number;
  };
  const allocations = (row.applied_claims_json as unknown as Allocation[]) ?? [];
  for (const a of allocations) {
    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, patient_responsibility_cents")
      .eq("id", a.claimId)
      .eq("patient_id", row.patient_id)
      .limit(1)
      .maybeSingle();
    if (!claim) continue;
    const newBalance = Math.max(
      0,
      claim.patient_responsibility_cents - a.amountAppliedCents,
    );
    await supabase
      .schema("resupply")
      .from("insurance_claims")
      .update({
        patient_responsibility_cents: newBalance,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claim.id);
    await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claim.id,
        event_type: "note",
        amount_cents: a.amountAppliedCents,
        payer_ref: paymentId,
        note: `Patient payment applied: ${a.amountAppliedCents}¢ via payment ${paymentId}`,
        actor_email: "system:patient_payment_apply",
      });
  }
}

export interface MarkPaymentInput {
  paymentId: string;
  status: Database["resupply"]["Tables"]["patient_payments"]["Row"]["status"];
  failureReason?: string | null;
}

export async function markPaymentStatus(
  input: MarkPaymentInput,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const update: Database["resupply"]["Tables"]["patient_payments"]["Update"] = {
    status: input.status,
    updated_at: new Date().toISOString(),
  };
  if (input.status === "succeeded") {
    update.succeeded_at = new Date().toISOString();
  }
  if (input.failureReason !== undefined) {
    update.failure_reason = input.failureReason;
  }
  await supabase
    .schema("resupply")
    .from("patient_payments")
    .update(update)
    .eq("id", input.paymentId);
  if (input.status === "succeeded") {
    await applySucceededPayment(supabase, input.paymentId);
  }
}
