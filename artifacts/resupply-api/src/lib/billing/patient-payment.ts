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

import { getStripeClient, readStripeConfigOrNull } from "../stripe/config";
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
    const { error: failStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason:
          err instanceof Error ? err.message.slice(0, 2000) : String(err),
      })
      .eq("id", row.id);
    if (failStampErr) {
      logger.error(
        { err: failStampErr.message, paymentId: row.id },
        "patient_payment: failed-status stamp failed — payment row stuck in created state",
      );
    }
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
      status:
        intent.status === "requires_action" ? "requires_action" : "pending",
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
    session = await stripe.checkout.sessions.create(
      {
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
    const { error: failStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason:
          err instanceof Error ? err.message.slice(0, 2000) : String(err),
      })
      .eq("id", row.id);
    if (failStampErr) {
      logger.error(
        { err: failStampErr.message, paymentId: row.id },
        "patient_payment: failed-status stamp failed — payment row stuck in created state",
      );
    }
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
    const { error: noUrlStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason: "Stripe session missing url",
      })
      .eq("id", row.id);
    if (noUrlStampErr) {
      logger.error(
        { err: noUrlStampErr.message, paymentId: row.id },
        "patient_payment: missing-url failed stamp failed — payment row stuck in created state",
      );
    }
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

// ─── Ad-hoc CSR-initiated payment link ────────────────────────────

export interface CreateAdhocCheckoutSessionInput {
  patientId: string;
  /** Amount to collect, in cents. Stripe's USD minimum is 50¢. */
  amountCents: number;
  /**
   * Customer-visible line-item label on the Stripe hosted page and the
   * emailed receipt. Defaults to a generic "Payment to PennPaps". Keep
   * it free of PHI — Stripe's receipt is not encrypted.
   */
  description?: string | null;
  /** Where Stripe sends the patient after a successful payment. */
  successUrl: string;
  /** Where Stripe sends the patient if they cancel mid-checkout. */
  cancelUrl: string;
  /** Caller for the audit/metadata trail (the admin's email). */
  initiatorEmail: string;
}

export interface CreateAdhocCheckoutFailure {
  error: "stripe_not_configured" | "stripe_rejected" | "invalid_amount";
  message: string;
}

/**
 * Create a hosted Stripe Checkout Session for an ARBITRARY amount a staff
 * member is collecting from a patient — a copay, a cash-pay item, a
 * balance not tracked as an insurance_claim.
 *
 * Unlike `createPaymentCheckoutSession`, this allocates against NO
 * claims: the patient_payments row carries an empty
 * `applied_claims_json` and `source='csr'`. On a succeeded payment the
 * existing webhook flips the row to 'succeeded' and the
 * `apply_patient_payment` RPC is a safe no-op — it early-returns on a
 * non-array / empty allocation list (migration 0214), so nothing is
 * decremented and nothing is double-applied. We stamp the same
 * `metadata.patient_payment_id` contract as the portal flows so the
 * webhook handler correlates the payment with zero new plumbing.
 *
 * Never auto-charges: the patient must open the returned `url` and pay.
 */
export async function createAdhocPaymentCheckoutSession(
  input: CreateAdhocCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult | CreateAdhocCheckoutFailure> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 50) {
    return {
      error: "invalid_amount",
      message: "amount must be a whole number of cents, at least 50",
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

  // Reserve our patient_payments row up front so the Checkout Session
  // metadata can reference it; if Stripe rejects we mark the row failed
  // so the audit trail is complete. source='csr' + empty allocations:
  // staff entered on behalf of the patient, not tied to a claim.
  const { data: row, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .insert({
      patient_id: input.patientId,
      amount_cents: input.amountCents,
      currency: "usd",
      status: "pending",
      applied_claims_json: [] as unknown as Json,
      source: "csr",
      note: input.description ?? null,
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const label =
    input.description && input.description.trim().length > 0
      ? input.description.trim().slice(0, 200)
      : "Payment to PennPaps";

  let session: Stripe.Checkout.Session;
  try {
    const stripe = getStripeClient(config);
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: input.amountCents,
              product_data: { name: label },
            },
          },
        ],
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          patient_payment_id: row.id,
          patient_id: input.patientId,
          source: "csr",
          initiator_email: input.initiatorEmail,
        },
        payment_intent_data: {
          metadata: {
            patient_payment_id: row.id,
            patient_id: input.patientId,
            source: "csr",
            initiator_email: input.initiatorEmail,
          },
        },
      },
      // Idempotency-key namespaced to the patient_payment row id so a
      // network retry collapses to one Checkout Session at Stripe. Each
      // fresh row id (= each fresh admin "send link" click) produces a
      // new Session.
      { idempotencyKey: `pennpaps-patient-adhoc-${row.id}` },
    );
  } catch (err) {
    const { error: failStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason:
          err instanceof Error ? err.message.slice(0, 2000) : String(err),
      })
      .eq("id", row.id);
    if (failStampErr) {
      logger.error(
        { err: failStampErr.message, paymentId: row.id },
        "patient_payment: adhoc failed-status stamp failed — payment row stuck in created state",
      );
    }
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "patient_payment: stripe adhoc checkout.sessions.create failed",
    );
    return {
      error: "stripe_rejected",
      message: "Stripe rejected the checkout session create",
    };
  }

  if (!session.url) {
    const { error: noUrlStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({
        status: "failed",
        failure_reason: "Stripe session missing url",
      })
      .eq("id", row.id);
    if (noUrlStampErr) {
      logger.error(
        { err: noUrlStampErr.message, paymentId: row.id },
        "patient_payment: adhoc missing-url failed stamp failed — payment row stuck in created state",
      );
    }
    return {
      error: "stripe_rejected",
      message: "Stripe returned a session without a hosted URL",
    };
  }

  return {
    paymentId: row.id,
    url: session.url,
    amountCents: input.amountCents,
  };
}

/**
 * Apply a succeeded payment: decrement patient_responsibility_cents on
 * each claim in the allocation, atomically and idempotently.
 *
 * Delegates to the `resupply.apply_patient_payment()` SQL function
 * (migration 0214). That function claims a per-(payment, claim) ledger
 * slot and decrements the claim balance in ONE transaction, so:
 *   * concurrent applies for DIFFERENT payments on the SAME claim never
 *     lose a decrement (the per-claim UPDATE is serialized by the row
 *     lock, and GREATEST(0, …) clamps); and
 *   * re-running the SAME payment is a no-op for slots already applied —
 *     which is what lets `markPaymentStatus` re-invoke this on Stripe
 *     redelivery to COMPLETE an apply that a crash interrupted between the
 *     status flip and the decrement, without double-decrementing.
 *
 * Unlike the previous JS read-modify-write loop, this can be called more
 * than once for the same paymentId safely.
 */
export async function applySucceededPayment(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .rpc("apply_patient_payment", { p_payment_id: paymentId });
  if (error) throw error;
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
    // Atomic check-and-set: only flip to 'succeeded' (and stamp
    // succeeded_at) when the row isn't already there, so a Stripe
    // redelivery doesn't rewrite succeeded_at.
    const { error: flipErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update(update)
      .eq("id", input.paymentId)
      .neq("status", "succeeded")
      .select("id");
    if (flipErr) throw flipErr;
    // Run the apply UNCONDITIONALLY — even when the flip was a no-op
    // (redelivery, or a retry after a crash that interrupted a prior
    // apply between the status flip and the decrement).
    // apply_patient_payment is idempotent (per-(payment, claim) ledger,
    // migration 0214), so this completes any unfinished decrement without
    // double-applying. The previous early-return-on-redelivery left a
    // crash-interrupted apply permanently incomplete (balance overstated).
    await applySucceededPayment(supabase, input.paymentId);
    return;
  }
  const { error: statusErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .update(update)
    .eq("id", input.paymentId);
  if (statusErr) throw statusErr;
}
