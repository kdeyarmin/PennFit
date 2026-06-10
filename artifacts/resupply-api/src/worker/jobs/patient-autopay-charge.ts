// pg-boss job: auto-charge a patient's outstanding balance off-session
// against the card they saved + authorized in the portal.
//
// SAFETY — three independent off switches, ALL required to move money
// (identical model to payment-plan-autocharge.ts):
//
//   1. OPT-IN CRON. Queue + worker always register; the recurring
//      schedule only attaches when BILLING_PATIENT_AUTOPAY_CRON is set.
//      Dev / preview / a fresh prod never auto-charge.
//   2. RUNTIME FEATURE FLAG. Even with the cron scheduled, the tick
//      checks billing.patient_autopay (seeded OFF, mig 0260) and no-ops
//      when off — a one-click kill switch with no deploy.
//   3. PER-PATIENT AUTHORIZATION + TOGGLE. We only charge patients who
//      saved a card via a Stripe setup mandate AND flipped their own
//      autopay switch ON (autopay_enabled). The pure selector also caps
//      attempts and charges at most once/patient/day.
//
// The charge is a synchronous off-session PaymentIntent confirm, so the
// outcome is known inline and persisted immediately. We also stamp the
// patient_payment_id into the PI metadata so the existing
// payment_intent.* webhook settles the same row idempotently if the
// inline path is interrupted.

import type PgBoss from "pg-boss";
import type Stripe from "stripe";

import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  markPaymentStatus,
  type CreateCheckoutSessionInput,
} from "../../lib/billing/patient-payment.js";
import {
  selectChargeableAuthorizations,
  type ChargeableAuthorization,
} from "../../lib/billing/patient-autopay.js";
import type {
  OffSessionCharger,
  OffSessionChargeResult,
} from "../../lib/billing/payment-plan-autocharge.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const PATIENT_AUTOPAY_CHARGE_JOB = "billing.patient-autopay-charge";

/** Claim statuses that carry a settled patient-responsibility balance. */
const OPEN_BALANCE_STATUSES = ["paid", "denied", "appealed", "closed"] as const;

type Allocation = CreateCheckoutSessionInput["allocations"][number];

/** Map a Stripe off-session PaymentIntent confirm into our charge result. */
function buildStripeOffSessionCharger(stripe: Stripe): OffSessionCharger {
  return async (req) => {
    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: "usd",
          customer: req.stripeCustomerId,
          payment_method: req.stripePaymentMethodId,
          off_session: true,
          confirm: true,
          metadata: req.metadata,
        },
        { idempotencyKey: req.idempotencyKey },
      );
      if (pi.status === "succeeded") {
        return { outcome: "succeeded", paymentIntentId: pi.id };
      }
      if (pi.status === "requires_action") {
        return { outcome: "requires_action", paymentIntentId: pi.id };
      }
      return {
        outcome: "failed",
        paymentIntentId: pi.id,
        reason: `unexpected_status:${pi.status}`,
      };
    } catch (err) {
      // Stripe throws on an off-session decline. authentication_required
      // means the card needs 3DS — recoverable via a patient re-auth, so
      // we surface it as requires_action rather than a hard decline.
      const e = err as {
        code?: string;
        message?: string;
        raw?: { payment_intent?: { id?: string; status?: string } };
      };
      const piId = e.raw?.payment_intent?.id ?? null;
      if (
        e.code === "authentication_required" ||
        e.raw?.payment_intent?.status === "requires_action"
      ) {
        return { outcome: "requires_action", paymentIntentId: piId };
      }
      return {
        outcome: "failed",
        paymentIntentId: piId,
        reason: (e.code ?? e.message ?? "charge_failed").slice(0, 500),
      };
    }
  };
}

export interface PatientAutopayRunStats {
  authorizationsConsidered: number;
  charged: number;
  requiresAction: number;
  failed: number;
  noBalance: number;
}

export interface PatientAutopayChargeDeps {
  /** Injected off-session charger (tests). Defaults to the Stripe confirm. */
  charger?: OffSessionCharger;
}

/** Load enabled authorizations, charge each patient's open balance. */
export async function runPatientAutopayCharge(
  deps: PatientAutopayChargeDeps = {},
): Promise<PatientAutopayRunStats> {
  const stats: PatientAutopayRunStats = {
    authorizationsConsidered: 0,
    charged: 0,
    requiresAction: 0,
    failed: 0,
    noBalance: 0,
  };
  let charger = deps.charger ?? null;
  if (!charger) {
    const config = readStripeConfigOrNull();
    if (!config) {
      logger.info(
        { queue: PATIENT_AUTOPAY_CHARGE_JOB },
        "patient-autopay-charge: Stripe not configured — skipping",
      );
      return stats;
    }
    charger = buildStripeOffSessionCharger(getStripeClient(config));
  }
  const supabase = getSupabaseServiceRoleClient();
  const todayIso = new Date().toISOString().slice(0, 10);

  // Keyset-page the enabled authorizations: PostgREST caps each
  // response at ~1000 rows, and an unpaginated read would silently
  // and permanently exclude every authorization past the cap.
  const PAGE_SIZE = 1000;
  const candidates: ChargeableAuthorization[] = [];
  let lastId: string | null = null;
  for (;;) {
    let query = supabase
      .schema("resupply")
      .from("patient_autopay_authorizations")
      .select(
        "id, patient_id, stripe_customer_id, stripe_payment_method_id, autopay_enabled, charge_attempts, last_charge_attempt_at",
      )
      .is("revoked_at", null)
      .eq("autopay_enabled", true)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId !== null) query = query.gt("id", lastId);
    const { data: rows, error } = await query;
    if (error) throw error;
    if (!rows || rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;
    for (const r of rows) {
      candidates.push({
        id: r.id,
        patientId: r.patient_id,
        stripeCustomerId: r.stripe_customer_id,
        stripePaymentMethodId: r.stripe_payment_method_id,
        autopayEnabled: r.autopay_enabled,
        chargeAttempts: r.charge_attempts ?? 0,
        lastChargeAttemptAt: r.last_charge_attempt_at,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  const due = selectChargeableAuthorizations(candidates, todayIso);

  for (const auth of due) {
    try {
      await chargeOneAuthorization(auth, charger, stats);
    } catch (err) {
      // One bad patient must not abort the whole tick.
      stats.failed += 1;
      logger.warn(
        { err, authorizationId: auth.id },
        "patient-autopay-charge: authorization charge errored",
      );
    }
  }
  return stats;
}

async function chargeOneAuthorization(
  auth: ChargeableAuthorization,
  charger: OffSessionCharger,
  stats: PatientAutopayRunStats,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const now = new Date().toISOString();

  // Compute the open balance + per-claim allocation.
  const { data: claims, error: claimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select("id, patient_responsibility_cents")
    .eq("patient_id", auth.patientId)
    .gt("patient_responsibility_cents", 0)
    .in("status", [...OPEN_BALANCE_STATUSES]);
  if (claimErr) throw claimErr;
  const allocations: Allocation[] = (claims ?? []).map((c) => ({
    claimId: c.id,
    amountAppliedCents: c.patient_responsibility_cents,
  }));
  const totalCents = allocations.reduce((s, a) => s + a.amountAppliedCents, 0);
  if (totalCents <= 0) {
    // Nothing owed — don't consume the attempt budget or stamp a date.
    stats.noBalance += 1;
    return;
  }

  // Double-charge guard: patient_responsibility_cents is only
  // decremented when a payment SETTLES, so a patient with an
  // unsettled manual payment in flight (a Stripe Checkout session can
  // stay completable for 24h, a requires_action PI even longer) still
  // shows the full balance here — charging now would collect it twice.
  // Skip the patient for this tick; pending rows are self-healing
  // (checkout.session.expired / payment_intent.* webhooks settle them)
  // and the next tick picks the patient up again. Skipping does not
  // consume the attempt budget or stamp last_charge_attempt_at. The
  // 7-day window bounds the guard: an orphaned PI-less pending row
  // (crash between insert and charge) has no webhook to settle it and
  // must not block the patient's autopay forever, while anything a
  // patient could still complete (24h checkout session, 3DS challenge)
  // is comfortably inside the window.
  const sevenDaysAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: unsettled, error: unsettledErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .select("id")
    .eq("patient_id", auth.patientId)
    .in("status", ["pending", "requires_action"])
    .gte("created_at", sevenDaysAgoIso)
    .limit(1);
  if (unsettledErr) throw unsettledErr;
  if (unsettled && unsettled.length > 0) {
    logger.info(
      { authorizationId: auth.id, patientPaymentId: unsettled[0]!.id },
      "patient-autopay-charge: unsettled payment in flight — skipping this tick",
    );
    stats.noBalance += 1;
    return;
  }
  stats.authorizationsConsidered += 1;

  // Atomic per-authorization claim — CAS on the scanned snapshot's
  // last_charge_attempt_at. pg-boss can run two overlapping ticks:
  // VENDOR_SEND_QUEUE_OPTS expires a tick after 15 minutes and retries
  // it, so a slow roster walk (or a deploy rollover's second replica)
  // can re-process the same authorization with a FRESH patient_payments
  // row — i.e. a different Stripe idempotency key and a real second
  // PaymentIntent. Stamping last_charge_attempt_at conditionally on the
  // exact value this tick scanned means exactly one overlapping tick
  // proceeds; the loser's UPDATE matches zero rows and skips. The stamp
  // is what selectChargeableAuthorizations keys the once-per-day rule
  // on, and the success/failure paths below overwrite it with this same
  // `now`, so claiming early changes no cadence. The enabled/revoked
  // re-check also drops a patient who turned autopay off between the
  // scan and the charge.
  let claim = supabase
    .schema("resupply")
    .from("patient_autopay_authorizations")
    .update({ last_charge_attempt_at: now, updated_at: now })
    .eq("id", auth.id)
    .eq("autopay_enabled", true)
    .is("revoked_at", null);
  claim =
    auth.lastChargeAttemptAt === null
      ? claim.is("last_charge_attempt_at", null)
      : claim.eq("last_charge_attempt_at", auth.lastChargeAttemptAt);
  const { data: claimedRows, error: claimError } = await claim.select("id");
  if (claimError) throw claimError;
  if (!claimedRows || claimedRows.length === 0) {
    logger.info(
      { authorizationId: auth.id },
      "patient-autopay-charge: claim lost (concurrent tick, or authorization revoked/disabled mid-run) — skipping",
    );
    return;
  }

  // Reserve the patient_payments row first so the PI metadata can
  // reference it (the webhook settles via patient_payment_id).
  const { data: payRow, error: insertErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .insert({
      patient_id: auth.patientId,
      amount_cents: totalCents,
      currency: "usd",
      status: "pending",
      applied_claims_json: allocations as unknown as Json,
      source: "autopay",
      note: "Automatic payment (card on file)",
    })
    .select("id")
    .single();
  if (insertErr) throw insertErr;

  const attempts = auth.chargeAttempts + 1;
  const result: OffSessionChargeResult = await charger({
    amountCents: totalCents,
    stripeCustomerId: auth.stripeCustomerId,
    stripePaymentMethodId: auth.stripePaymentMethodId,
    idempotencyKey: `pennpaps-patient-autopay-${payRow.id}`,
    metadata: {
      patient_id: auth.patientId,
      patient_payment_id: payRow.id,
      source: "autopay",
    },
  });

  if (result.outcome === "succeeded") {
    const { error: piStampErr } = await supabase
      .schema("resupply")
      .from("patient_payments")
      .update({ stripe_payment_intent_id: result.paymentIntentId })
      .eq("id", payRow.id);
    if (piStampErr) {
      logger.warn(
        { err: piStampErr.message, paymentId: payRow.id },
        "autopay: failed to stamp payment_intent_id on success — charge already captured",
      );
    }
    // Flip to succeeded + apply the allocation (idempotent; the webhook
    // redelivery completes it too if this is interrupted).
    await markPaymentStatus({ paymentId: payRow.id, status: "succeeded" });
    const { error: authResetErr } = await supabase
      .schema("resupply")
      .from("patient_autopay_authorizations")
      .update({
        charge_attempts: 0,
        last_charge_error: null,
        last_charge_attempt_at: now,
        updated_at: now,
      })
      .eq("id", auth.id);
    if (authResetErr) {
      logger.warn(
        { err: authResetErr.message, authId: auth.id },
        "autopay: failed to reset charge_attempts after success — retry counter may be stale",
      );
    }
    stats.charged += 1;
    return;
  }

  const failureStatus =
    result.outcome === "requires_action" ? "requires_action" : "failed";
  const reason =
    result.outcome === "requires_action" ? "requires_action" : result.reason;
  const { error: payFailErr } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .update({
      status: failureStatus,
      stripe_payment_intent_id: result.paymentIntentId,
      failure_reason: reason,
      updated_at: now,
    })
    .eq("id", payRow.id);
  if (payFailErr) {
    logger.error(
      { err: payFailErr.message, paymentId: payRow.id, failureStatus },
      "autopay: failed to update payment status after charge failure — payment row may be stuck in pending",
    );
  }
  const { error: authFailErr } = await supabase
    .schema("resupply")
    .from("patient_autopay_authorizations")
    .update({
      charge_attempts: attempts,
      last_charge_error: reason.slice(0, 2000),
      last_charge_attempt_at: now,
      updated_at: now,
    })
    .eq("id", auth.id);
  if (authFailErr) {
    logger.warn(
      { err: authFailErr.message, authId: auth.id },
      "autopay: failed to record charge failure on authorization — retry cadence may be incorrect",
    );
  }
  if (result.outcome === "requires_action") stats.requiresAction += 1;
  else stats.failed += 1;
}

export async function registerPatientAutopayChargeJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    PATIENT_AUTOPAY_CHARGE_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(PATIENT_AUTOPAY_CHARGE_JOB, async () => {
    const enabled = await isFeatureEnabled("billing.patient_autopay");
    if (!enabled) {
      logger.info(
        { queue: PATIENT_AUTOPAY_CHARGE_JOB },
        "patient-autopay-charge: feature flag off — nothing charged",
      );
      return;
    }
    const stats = await runPatientAutopayCharge();
    logger.info(
      { event: "billing.patient-autopay-charge.completed", ...stats },
      "patient-autopay-charge: tick",
    );
  });

  const cron = process.env.BILLING_PATIENT_AUTOPAY_CRON?.trim();
  if (cron) {
    await boss.schedule(PATIENT_AUTOPAY_CHARGE_JOB, cron);
    // Don't log the raw cron string — CodeQL flags logging env values.
    logger.info(
      { queue: PATIENT_AUTOPAY_CHARGE_JOB, scheduled: true },
      "patient-autopay-charge scheduled",
    );
  } else {
    logger.info(
      { queue: PATIENT_AUTOPAY_CHARGE_JOB },
      "patient-autopay-charge registered (cron opt-in unset)",
    );
  }
}
