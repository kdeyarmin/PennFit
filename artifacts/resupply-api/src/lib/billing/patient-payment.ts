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
  error:
    | "stripe_not_configured"
    | "stripe_rejected"
    | "no_allocations"
    | "claim_not_owned"
    | "claim_balance_mismatch";
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
  const { data: claimsData, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_id, patient_responsibility_cents")
    .in("id", claimIds);
  if (error) {
    logger.warn(
      { err: error, patientId: input.patientId },
      "patient_payment: failed to fetch insurance_claims",
    );
    throw new Error(`Database query failed: ${error.message}`);
  }
  for (const allocation of input.allocations) {
    const claim = (claimsData ?? []).find((c) => c.id === allocation.claimId);
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
    intent = await stripe.paymentIntents.create(
      {
        amount: totalCents,
        currency: "usd",
        payment_method_types: input.paymentMethodTypes ?? ["card"],
        metadata: {
          patient_id: input.patientId,
          patient_payment_id: row.id,
          source: input.source,
          initiator_email: input.initiatorEmail,
        },
      },
      // Idempotency-key namespaced to our patient_payment row id so a
      // network-level retry of this single attempt collapses to one
      // PaymentIntent at Stripe. Each fresh row id (= each fresh
      // patient click on "Pay") still produces a new PI -- the row
      // id is generated server-side on insert and is unique per
      // attempt.
      { idempotencyKey: `pennpaps-patient-payment-${row.id}` },
    );
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
      error: "stripe_rejected",
      message: "Stripe rejected the payment intent create",
    };
  }

  // First stamp the PaymentIntent id so the webhook can correlate.
  const { error: updateErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .update({
      stripe_payment_intent_id: intent.id,
      status: intent.status === "requires_action" ? "requires_action" : "pending",
    })
    .eq("id", row.id);
  if (updateErr) {
    logger.error(
      { err: updateErr.message, paymentId: row.id, intentId: intent.id },
      "patient_payment: failed to link PaymentIntent to patient_payments row",
    );
    throw new Error(`Database update failed: ${updateErr.message}`);
  }

  // If Stripe returned succeeded synchronously (rare; usually
  // confirm-on-client), route through the same check-and-set
  // markPaymentStatus that the webhook uses. This guarantees the
  // allocation walk runs exactly once even if the webhook redelivers
  // payment_intent.succeeded a moment later.
  if (intent.status === "succeeded") {
    await markPaymentStatus({ paymentId: row.id, status: "succeeded" });
  }

  return {
    paymentId: row.id,
    paymentIntentClientSecret: intent.client_secret ?? "",
    amountCents: totalCents,
  };
}

// ─── Stripe Checkout Session (hosted card-on-file flow) ───────────

export interface CreateCheckoutSessionInput {
  patientId: string;
  allocations: Array<{
    claimId: string;
    amountAppliedCents: number;
  }>;
  /** Where Stripe sends the customer after a successful payment. */
  successUrl: string;
  /** Where Stripe sends the customer if they cancel mid-checkout. */
  cancelUrl: string;
  /** Caller for the audit trail. */
  initiatorEmail: string;
}

export interface CreateCheckoutSessionResult {
  paymentId: string;
  url: string;
  amountCents: number;
}

/**
 * Hosted-checkout equivalent of `createPaymentIntent`. Mirrors the
 * /shop/checkout pattern (Stripe Checkout Session → redirect URL)
 * but for an arbitrary patient_responsibility balance instead of a
 * cart of products. The existing webhook handler at
 * lib/stripe/webhook-handler.ts processes payment_intent.* on the
 * patient_payment_id metadata key — we set the same metadata here
 * via `payment_intent_data` so no new webhook plumbing is needed.
 */
export async function createPaymentCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult | CreateIntentFailure> {
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

  // Same per-allocation ownership + balance gates as the intent
  // flow — duplicated here rather than refactored because the
  // failure modes intentionally surface as different HTTP statuses.
  //
  // Known concurrency caveat: this validation is not atomic with
  // the patient_payments insert below. Two checkout-session
  // creations racing on the same claim can both pass the
  // claim_balance_mismatch gate before either reserves. The
  // applySucceededPayment() webhook decrements
  // patient_responsibility_cents row-by-row on succeeded events,
  // and a subsequent payment attempt on the now-zero balance
  // returns claim_balance_mismatch — so the worst-case observable
  // outcome is one duplicate authorisation (rare in practice: the
  // gap between SELECT and the Stripe API call is sub-second; the
  // patient has to click "Pay" twice in two tabs that fast). A
  // real fix would put a SELECT ... FOR UPDATE on the claim row
  // inside a transaction or take an advisory lock keyed on
  // claim_id; tracked separately as a heavier lift.
  const claimIds = input.allocations.map((a) => a.claimId);
  const { data: claimsData, error } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_id, patient_responsibility_cents")
    .in("id", claimIds);
  if (error) {
    logger.warn(
      { err: error, patientId: input.patientId },
      "patient_payment: failed to fetch insurance_claims",
    );
    throw new Error(`Database query failed: ${error.message}`);
  }
  for (const allocation of input.allocations) {
    const claim = (claimsData ?? []).find((c) => c.id === allocation.claimId);
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

  // Reserve our patient_payments row up front so the Checkout
  // Session metadata can reference it; if Stripe rejects we mark
  // the row failed so the audit trail is complete.
  const { data: row, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .insert({
      patient_id: input.patientId,
      amount_cents: totalCents,
      currency: "usd",
      status: "pending",
      applied_claims_json: input.allocations as unknown as Json,
      source: "portal",
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  let session: Stripe.Checkout.Session;
  try {
    const stripe = getStripeClient(config);
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      // We only have one synthetic line item: "Patient balance —
      // $X.XX". The breakdown is in our DB via applied_claims_json;
      // exposing per-claim line items here would leak PHI in the
      // hosted page (claim IDs render in the receipt).
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: "Patient balance — PennPaps",
            },
          },
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      // The metadata.patient_payment_id key is what
      // webhook-handler.ts looks for on payment_intent.* — keep
      // both layers stamped so a refund webhook hitting the
      // Session also resolves to our row.
      metadata: {
        patient_payment_id: row.id,
        patient_id: input.patientId,
        source: "portal",
        initiator_email: input.initiatorEmail,
      },
      payment_intent_data: {
        metadata: {
          patient_payment_id: row.id,
          patient_id: input.patientId,
          source: "portal",
          initiator_email: input.initiatorEmail,
        },
      },
    },
    // Idempotency-key namespaced to the patient_payment row id so
    // a network retry collapses to one Checkout Session at Stripe.
    // Each fresh row id (= each fresh patient checkout intent)
    // still produces a new Session.
    { idempotencyKey: `pennpaps-patient-checkout-${row.id}` },
    );
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
      "patient_payment: stripe checkout.sessions.create failed",
    );
    return {
      error: "stripe_not_configured",
      message: "Stripe rejected the checkout session create",
    };
  }

  if (!session.url) {
    // Stripe should always return a URL for hosted sessions; this
    // is belt-and-braces for the typed-as-nullable field. Mark the
    // row as failed before returning.
    await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason: "Stripe session missing url",
      })
      .eq("id", row.id);
    return {
      error: "stripe_not_configured",
      message: "Stripe returned a session without a hosted URL",
    };
  }

  return {
    paymentId: row.id,
    url: session.url,
    amountCents: totalCents,
  };
}

/**
 * Apply a succeeded payment: decrement patient_responsibility_cents
 * on each claim in the allocation.
 *
 * Caller contract: only invoke this AFTER an atomic transition of
 * patient_payments.status from non-'succeeded' to 'succeeded'. See
 * `markPaymentStatus` for the check-and-set that gates this. Calling
 * twice on the same paymentId WILL double-decrement claim balances.
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
  if (input.status === "succeeded") {
    // Atomic check-and-set: only flip to 'succeeded' when the row
    // isn't already there. Stripe redelivers webhooks on transient
    // 5xx, and we don't want to re-apply the per-claim balance
    // decrement on every redelivery. The .neq("status", "succeeded")
    // guard turns a re-delivery into a no-op at the SQL level, so
    // applySucceededPayment below runs exactly once per payment row.
    const { data: flipped, error: flipErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update(update)
      .eq("id", input.paymentId)
      .neq("status", "succeeded")
      .select("id");
    if (flipErr) throw flipErr;
    // .update().select() returns the rows actually updated. An empty
    // array means the row was already 'succeeded' — webhook redelivery,
    // skip the allocation walk so we don't double-decrement claims.
    if (!flipped || flipped.length === 0) return;
    await applySucceededPayment(supabase, input.paymentId);
    return;
  }
  await supabase
    .schema("resupply")
    .from("patient_payments")
    .update(update)
    .eq("id", input.paymentId);
}
