// Auto-charge orchestration for patient payment-plan installments
// (financing / biller #B7 follow-up).
//
// SAFETY CONTRACT — read before touching:
//   * This moves real money off-session. Nothing here charges a card
//     unless the plan is autopay_status='authorized' AND carries both a
//     stripe_customer_id and a stripe_payment_method_id that the patient
//     authorized via a Stripe setup mandate (see authorize-autopay route
//     + the checkout.session.completed[mode=setup] webhook branch).
//   * The selector is PURE and unit-tested; chargeInstallment takes the
//     Stripe charger + a persistence sink as injected deps so the
//     money-movement path is exercised in tests without a live Stripe.
//   * The caller (worker) is feature-flagged (billing.payment_plan_
//     autocharge, seeded OFF) and env-cron gated, so this is inert by
//     default.

export type AutopayStatus = "off" | "pending" | "authorized" | "revoked";

export interface AutochargePlan {
  id: string;
  patientId: string;
  autopayStatus: AutopayStatus;
  stripeCustomerId: string | null;
  stripePaymentMethodId: string | null;
}

export interface AutochargeInstallment {
  id: string;
  planId: string;
  seq: number;
  /** YYYY-MM-DD. */
  dueDate: string;
  amountCents: number;
  status: string;
  chargeAttempts: number;
}

/** Max automatic attempts before we stop and leave it for a human. */
export const MAX_CHARGE_ATTEMPTS = 4;

/**
 * Pure: given a plan, its installments, and "today" (YYYY-MM-DD), return
 * the installments that are eligible to be auto-charged right now.
 *
 * An installment is chargeable iff ALL hold:
 *   * the plan is authorized for autopay with a stored customer + PM,
 *   * the installment is due today or earlier,
 *   * its status is one we charge ('scheduled' | 'overdue' | the
 *     're-tryable' 'action_required'/'failed'), NOT already paid/waived,
 *   * it hasn't exhausted MAX_CHARGE_ATTEMPTS.
 */
export function selectChargeableInstallments(
  plan: AutochargePlan,
  installments: AutochargeInstallment[],
  todayIso: string,
): AutochargeInstallment[] {
  if (
    plan.autopayStatus !== "authorized" ||
    !plan.stripeCustomerId ||
    !plan.stripePaymentMethodId
  ) {
    return [];
  }
  const CHARGEABLE_STATUSES = new Set([
    "scheduled",
    "overdue",
    "action_required",
    "failed",
  ]);
  return installments.filter(
    (i) =>
      CHARGEABLE_STATUSES.has(i.status) &&
      i.dueDate <= todayIso &&
      i.chargeAttempts < MAX_CHARGE_ATTEMPTS,
  );
}

// ── Charge orchestration (deps injected) ────────────────────────────────

export interface OffSessionChargeRequest {
  amountCents: number;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  /** Idempotency key — one per (installment, attempt). */
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export type OffSessionChargeResult =
  | { outcome: "succeeded"; paymentIntentId: string }
  | { outcome: "requires_action"; paymentIntentId: string | null }
  | { outcome: "failed"; paymentIntentId: string | null; reason: string };

/** Injected money-mover — a thin wrapper over Stripe PaymentIntents. */
export type OffSessionCharger = (
  req: OffSessionChargeRequest,
) => Promise<OffSessionChargeResult>;

/** Injected persistence — records the outcome on the installment row. */
export interface AutochargeSink {
  markPaid(input: {
    installmentId: string;
    paymentIntentId: string;
  }): Promise<void>;
  markFailed(input: {
    installmentId: string;
    attempts: number;
    status: "action_required" | "failed";
    reason: string;
    paymentIntentId: string | null;
  }): Promise<void>;
}

export interface ChargeOneResult {
  installmentId: string;
  outcome: OffSessionChargeResult["outcome"];
}

/**
 * Charge a single installment once. Maps the Stripe outcome to the
 * persisted installment state:
 *   succeeded        → status=paid, stamps the PI.
 *   requires_action  → status=action_required (3DS / re-auth needed; the
 *                      patient must complete a step — we don't retry blind).
 *   failed           → status=failed (declined / error), attempts++.
 * Never throws on a charge decline — only on a programmer error.
 */
export async function chargeInstallment(
  plan: AutochargePlan,
  installment: AutochargeInstallment,
  charger: OffSessionCharger,
  sink: AutochargeSink,
): Promise<ChargeOneResult> {
  if (!plan.stripeCustomerId || !plan.stripePaymentMethodId) {
    // Defensive: selectChargeableInstallments already excludes these.
    throw new Error("chargeInstallment called on a plan without a stored PM");
  }
  const attempts = installment.chargeAttempts + 1;
  const result = await charger({
    amountCents: installment.amountCents,
    stripeCustomerId: plan.stripeCustomerId,
    stripePaymentMethodId: plan.stripePaymentMethodId,
    idempotencyKey: `pennpaps-autopay-${installment.id}-${attempts}`,
    metadata: {
      payment_plan_id: plan.id,
      payment_plan_installment_id: installment.id,
      patient_id: plan.patientId,
      source: "autopay",
    },
  });

  if (result.outcome === "succeeded") {
    await sink.markPaid({
      installmentId: installment.id,
      paymentIntentId: result.paymentIntentId,
    });
    return { installmentId: installment.id, outcome: "succeeded" };
  }
  if (result.outcome === "requires_action") {
    await sink.markFailed({
      installmentId: installment.id,
      attempts,
      status: "action_required",
      reason: "requires_action",
      paymentIntentId: result.paymentIntentId,
    });
    return { installmentId: installment.id, outcome: "requires_action" };
  }
  await sink.markFailed({
    installmentId: installment.id,
    attempts,
    status: "failed",
    reason: result.reason,
    paymentIntentId: result.paymentIntentId,
  });
  return { installmentId: installment.id, outcome: "failed" };
}
