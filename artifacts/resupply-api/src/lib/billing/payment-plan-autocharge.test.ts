import { describe, expect, it, vi } from "vitest";

import {
  chargeInstallment,
  selectChargeableInstallments,
  MAX_CHARGE_ATTEMPTS,
  type AutochargeInstallment,
  type AutochargePlan,
  type AutochargeSink,
  type OffSessionCharger,
  type OffSessionChargeResult,
} from "./payment-plan-autocharge";

const authorizedPlan: AutochargePlan = {
  id: "plan_1",
  patientId: "pat_1",
  autopayStatus: "authorized",
  stripeCustomerId: "cus_1",
  stripePaymentMethodId: "pm_1",
};

function inst(p: Partial<AutochargeInstallment>): AutochargeInstallment {
  return {
    id: "i1",
    planId: "plan_1",
    seq: 1,
    dueDate: "2026-06-01",
    amountCents: 5000,
    status: "scheduled",
    chargeAttempts: 0,
    ...p,
  };
}

describe("selectChargeableInstallments", () => {
  const today = "2026-06-09";

  it("selects due, unpaid, under-attempt-cap installments on an authorized plan", () => {
    const out = selectChargeableInstallments(
      authorizedPlan,
      [
        inst({ id: "due_scheduled", dueDate: "2026-06-01" }),
        inst({ id: "due_overdue", status: "overdue", dueDate: "2026-05-01" }),
        inst({ id: "future", dueDate: "2026-07-01" }),
        inst({ id: "already_paid", status: "paid" }),
        inst({ id: "waived", status: "waived" }),
        inst({
          id: "exhausted",
          status: "failed",
          chargeAttempts: MAX_CHARGE_ATTEMPTS,
        }),
        // a prior hard-decline is retryable while under the attempt cap
        inst({ id: "retryable_failed", status: "failed", chargeAttempts: 1 }),
        // 3DS/re-auth pending — NOT retried blindly
        inst({
          id: "needs_action",
          status: "action_required",
          chargeAttempts: 1,
        }),
      ],
      today,
    );
    expect(out.map((i) => i.id).sort()).toEqual([
      "due_overdue",
      "due_scheduled",
      "retryable_failed",
    ]);
  });

  it("charges nothing when the plan is not authorized", () => {
    for (const status of ["off", "pending", "revoked"] as const) {
      expect(
        selectChargeableInstallments(
          { ...authorizedPlan, autopayStatus: status },
          [inst({})],
          today,
        ),
      ).toHaveLength(0);
    }
  });

  it("charges nothing when the stored customer or PM is missing", () => {
    expect(
      selectChargeableInstallments(
        { ...authorizedPlan, stripePaymentMethodId: null },
        [inst({})],
        today,
      ),
    ).toHaveLength(0);
    expect(
      selectChargeableInstallments(
        { ...authorizedPlan, stripeCustomerId: null },
        [inst({})],
        today,
      ),
    ).toHaveLength(0);
  });
});

describe("chargeInstallment", () => {
  function makeSink(): AutochargeSink & {
    paid: unknown[];
    failed: unknown[];
  } {
    const paid: unknown[] = [];
    const failed: unknown[] = [];
    return {
      paid,
      failed,
      markPaid: vi.fn(async (x) => {
        paid.push(x);
      }),
      markFailed: vi.fn(async (x) => {
        failed.push(x);
      }),
    };
  }

  it("marks paid on a successful off-session charge", async () => {
    const sink = makeSink();
    const charger = vi.fn(
      async (): Promise<OffSessionChargeResult> => ({
        outcome: "succeeded",
        paymentIntentId: "pi_ok",
      }),
    );
    const res = await chargeInstallment(
      authorizedPlan,
      inst({ id: "i_ok" }),
      charger,
      sink,
    );
    expect(res.outcome).toBe("succeeded");
    expect(sink.paid).toEqual([
      { installmentId: "i_ok", paymentIntentId: "pi_ok" },
    ]);
    expect(sink.failed).toHaveLength(0);
  });

  it("uses a per-attempt idempotency key", async () => {
    const sink = makeSink();
    const charger = vi.fn(
      async (): Promise<OffSessionChargeResult> => ({
        outcome: "succeeded",
        paymentIntentId: "pi",
      }),
    );
    await chargeInstallment(
      authorizedPlan,
      inst({ id: "i9", chargeAttempts: 2 }),
      charger,
      sink,
    );
    expect(charger).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "pennpaps-autopay-i9-3",
        amountCents: 5000,
        stripeCustomerId: "cus_1",
        stripePaymentMethodId: "pm_1",
      }),
    );
  });

  it("marks action_required (not failed) when Stripe needs 3DS", async () => {
    const sink = makeSink();
    const charger: OffSessionCharger = async () => ({
      outcome: "requires_action",
      paymentIntentId: "pi_3ds",
    });
    const res = await chargeInstallment(
      authorizedPlan,
      inst({ id: "i_3ds", chargeAttempts: 0 }),
      charger,
      sink,
    );
    expect(res.outcome).toBe("requires_action");
    expect(sink.failed).toEqual([
      {
        installmentId: "i_3ds",
        attempts: 1,
        status: "action_required",
        reason: "requires_action",
        paymentIntentId: "pi_3ds",
      },
    ]);
  });

  it("marks failed and increments attempts on a decline", async () => {
    const sink = makeSink();
    const charger: OffSessionCharger = async () => ({
      outcome: "failed",
      paymentIntentId: null,
      reason: "card_declined",
    });
    const res = await chargeInstallment(
      authorizedPlan,
      inst({ id: "i_dec", chargeAttempts: 1 }),
      charger,
      sink,
    );
    expect(res.outcome).toBe("failed");
    expect(sink.failed).toEqual([
      {
        installmentId: "i_dec",
        attempts: 2,
        status: "failed",
        reason: "card_declined",
        paymentIntentId: null,
      },
    ]);
  });
});
