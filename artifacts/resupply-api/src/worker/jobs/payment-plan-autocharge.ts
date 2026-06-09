// pg-boss job: auto-charge due patient payment-plan installments
// off-session (financing / biller #B7 follow-up).
//
// SAFETY — three independent off switches, ALL required to move money:
//
//   1. OPT-IN CRON. Queue + worker always register; the recurring
//      schedule only attaches when BILLING_PAYMENT_PLAN_AUTOCHARGE_CRON
//      is set. Dev / preview / a fresh prod never auto-charge.
//   2. RUNTIME FEATURE FLAG. Even with the cron scheduled, the tick
//      checks billing.payment_plan_autocharge (seeded OFF, mig 0254) and
//      no-ops when off — a one-click kill switch with no deploy.
//   3. PER-PLAN AUTHORIZATION. selectChargeableInstallments only returns
//      installments on plans the patient authorized via a Stripe setup
//      mandate (autopay_status='authorized' + stored customer + PM).
//
// The charge is a synchronous off-session PaymentIntent confirm, so the
// outcome (succeeded / requires_action / declined) is known inline and
// persisted immediately — no webhook round-trip for the money movement.

import type PgBoss from "pg-boss";
import type Stripe from "stripe";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../../lib/feature-flags.js";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config.js";
import {
  chargeInstallment,
  selectChargeableInstallments,
  type AutochargeInstallment,
  type AutochargePlan,
  type AutochargeSink,
  type OffSessionCharger,
} from "../../lib/billing/payment-plan-autocharge.js";
import { logger } from "../../lib/logger.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const PAYMENT_PLAN_AUTOCHARGE_JOB = "billing.payment-plan-autocharge";

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
      // means the card needs 3DS — recoverable via a patient re-auth,
      // not a hard decline, so we surface it as requires_action.
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

function buildSupabaseSink(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
): AutochargeSink {
  return {
    async markPaid({ installmentId, paymentIntentId }) {
      const { error } = await supabase
        .schema("resupply")
        .from("patient_payment_plan_installments")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          stripe_payment_intent_id: paymentIntentId,
          last_charge_attempt_at: new Date().toISOString(),
          last_charge_error: null,
        })
        .eq("id", installmentId);
      if (error) throw error;
    },
    async markFailed({
      installmentId,
      attempts,
      status,
      reason,
      paymentIntentId,
    }) {
      const { error } = await supabase
        .schema("resupply")
        .from("patient_payment_plan_installments")
        .update({
          status,
          charge_attempts: attempts,
          last_charge_error: reason.slice(0, 2000),
          last_charge_attempt_at: new Date().toISOString(),
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq("id", installmentId);
      if (error) throw error;
    },
  };
}

export interface AutochargeRunStats {
  plansConsidered: number;
  charged: number;
  requiresAction: number;
  failed: number;
}

/** Load authorized plans, charge their due installments. */
export async function runPaymentPlanAutocharge(): Promise<AutochargeRunStats> {
  const stats: AutochargeRunStats = {
    plansConsidered: 0,
    charged: 0,
    requiresAction: 0,
    failed: 0,
  };
  const config = readStripeConfigOrNull();
  if (!config) {
    logger.info(
      { queue: PAYMENT_PLAN_AUTOCHARGE_JOB },
      "payment-plan-autocharge: Stripe not configured — skipping",
    );
    return stats;
  }
  const supabase = getSupabaseServiceRoleClient();
  const charger = buildStripeOffSessionCharger(getStripeClient(config));
  const sink = buildSupabaseSink(supabase);
  const todayIso = new Date().toISOString().slice(0, 10);

  const { data: plans, error: planErr } = await supabase
    .schema("resupply")
    .from("patient_payment_plans")
    .select(
      "id, patient_id, autopay_status, stripe_customer_id, stripe_payment_method_id",
    )
    .eq("status", "active")
    .eq("autopay_status", "authorized");
  if (planErr) throw planErr;

  for (const p of plans ?? []) {
    const plan: AutochargePlan = {
      id: p.id,
      patientId: p.patient_id,
      autopayStatus: "authorized",
      stripeCustomerId: p.stripe_customer_id,
      stripePaymentMethodId: p.stripe_payment_method_id,
    };
    const { data: instRows, error: instErr } = await supabase
      .schema("resupply")
      .from("patient_payment_plan_installments")
      .select(
        "id, plan_id, seq, due_date, amount_cents, status, charge_attempts",
      )
      .eq("plan_id", p.id);
    if (instErr) throw instErr;

    const installments: AutochargeInstallment[] = (instRows ?? []).map((r) => ({
      id: r.id,
      planId: r.plan_id,
      seq: r.seq,
      dueDate: r.due_date,
      amountCents: r.amount_cents,
      status: r.status,
      chargeAttempts: r.charge_attempts ?? 0,
    }));
    const due = selectChargeableInstallments(plan, installments, todayIso);
    if (due.length === 0) continue;
    stats.plansConsidered += 1;

    for (const inst of due) {
      const res = await chargeInstallment(plan, inst, charger, sink);
      if (res.outcome === "succeeded") stats.charged += 1;
      else if (res.outcome === "requires_action") stats.requiresAction += 1;
      else stats.failed += 1;
    }
  }
  return stats;
}

export async function registerPaymentPlanAutochargeJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    PAYMENT_PLAN_AUTOCHARGE_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(PAYMENT_PLAN_AUTOCHARGE_JOB, async () => {
    const enabled = await isFeatureEnabled("billing.payment_plan_autocharge");
    if (!enabled) {
      logger.info(
        { queue: PAYMENT_PLAN_AUTOCHARGE_JOB },
        "payment-plan-autocharge: feature flag off — nothing charged",
      );
      return;
    }
    const stats = await runPaymentPlanAutocharge();
    logger.info(
      { event: "billing.payment-plan-autocharge.completed", ...stats },
      "payment-plan-autocharge: tick",
    );
  });

  const cron = process.env.BILLING_PAYMENT_PLAN_AUTOCHARGE_CRON?.trim();
  if (cron) {
    await boss.schedule(PAYMENT_PLAN_AUTOCHARGE_JOB, cron);
    // Don't log the raw cron string — it's read straight from the
    // environment and CodeQL flags logging env values as clear-text
    // logging of sensitive information. The boolean is all ops needs.
    logger.info(
      { queue: PAYMENT_PLAN_AUTOCHARGE_JOB, scheduled: true },
      "payment-plan-autocharge scheduled",
    );
  } else {
    logger.info(
      { queue: PAYMENT_PLAN_AUTOCHARGE_JOB },
      "payment-plan-autocharge registered (cron opt-in unset)",
    );
  }
}
