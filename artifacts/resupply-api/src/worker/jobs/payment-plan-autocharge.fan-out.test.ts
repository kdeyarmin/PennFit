// Payment-plan autocharge: multi-tenant fan-out + Stripe Connect routing.
//
// The charge orchestration (selectChargeableInstallments / chargeInstallment)
// is unit-tested in lib/billing/payment-plan-autocharge.test.ts. Here we
// verify the WORKER fans out across active tenants and routes each tenant's
// off-session charge to its own connected account.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// Stripe platform client — capture the PaymentIntent create options so we can
// assert the per-tenant `stripeAccount` routing.
const piCreate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/stripe/config.js", () => ({
  readStripeConfigOrNull: () => ({ secretKey: "sk_test_x" }),
  getStripeClient: () => ({ paymentIntents: { create: piCreate } }),
}));

// Connect routing — controllable per test. Default `{}` = platform account.
const connectAcctOpts = vi.hoisted(() => ({
  value: {} as { stripeAccount?: string },
}));
vi.mock("../../lib/stripe/connect.js", () => ({
  stripeAccountRequestOptions: vi.fn(async () => connectAcctOpts.value),
}));

import { runPaymentPlanAutocharge } from "./payment-plan-autocharge";

beforeEach(() => {
  supabaseMock.reset();
  connectAcctOpts.value = {};
  piCreate.mockReset();
  stageSupabaseResponse("organizations", "select", {
    data: [{ id: "00000000-0000-4000-8000-000000000001" }],
  });
});

describe("runPaymentPlanAutocharge — multi-tenant fan-out", () => {
  it("scans each active tenant's plans (empty → nothing charged)", async () => {
    supabaseMock.reset();
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    stageSupabaseResponse("patient_payment_plans", "select", { data: [] });
    stageSupabaseResponse("patient_payment_plans", "select", { data: [] });

    const stats = await runPaymentPlanAutocharge();
    expect(stats.charged).toBe(0);
    expect(stats.plansConsidered).toBe(0);
    expect(getSupabaseCallCount("patient_payment_plans", "select")).toBe(2);
    expect(piCreate).not.toHaveBeenCalled();
  });

  it("no-ops when there are no active tenants", async () => {
    supabaseMock.reset();
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runPaymentPlanAutocharge();
    expect(stats.plansConsidered).toBe(0);
    expect(getSupabaseCallCount("patient_payment_plans", "select")).toBe(0);
  });

  it("re-throws after fan-out when a tenant fails (prompt pg-boss retry)", async () => {
    // Money-path retry safety: a per-tenant throw (here, a plan-scan DB
    // error standing in for a post-charge sink.markPaid failure) is caught
    // by forEachActiveOrg, so the wrapper must re-surface it so pg-boss
    // retries promptly rather than waiting for the next cron tick.
    // beforeEach already staged one active org.
    stageSupabaseResponse("patient_payment_plans", "select", {
      error: { message: "db down" },
    });
    await expect(runPaymentPlanAutocharge()).rejects.toThrow(
      /tenant\(s\) failed/,
    );
  });

  it("routes the off-session charge to the tenant's connected account (G5)", async () => {
    connectAcctOpts.value = { stripeAccount: "acct_tenant" };
    // One authorized plan with one overdue, chargeable installment.
    stageSupabaseResponse("patient_payment_plans", "select", {
      data: [
        {
          id: "plan-1",
          patient_id: "pat-1",
          autopay_status: "authorized",
          stripe_customer_id: "cus_1",
          stripe_payment_method_id: "pm_1",
        },
      ],
    });
    stageSupabaseResponse("patient_payment_plan_installments", "select", {
      data: [
        {
          id: "inst-1",
          plan_id: "plan-1",
          seq: 1,
          due_date: "2020-01-01",
          amount_cents: 5000,
          status: "scheduled",
          charge_attempts: 0,
          last_charge_attempt_at: null,
        },
      ],
    });
    // Claim won.
    stageSupabaseResponse("patient_payment_plan_installments", "update", {
      data: [{ id: "inst-1" }],
    });
    // markPaid + plan-completion writes succeed.
    stageSupabaseResponse("patient_payment_plan_installments", "update", {
      data: [{ id: "inst-1" }],
    });
    stageSupabaseResponse("patient_payment_plans", "update", { data: [] });

    piCreate.mockResolvedValue({ id: "pi_1", status: "succeeded" });

    const stats = await runPaymentPlanAutocharge();

    expect(stats.charged).toBe(1);
    expect(piCreate).toHaveBeenCalledTimes(1);
    // Second arg to paymentIntents.create carries the connected account.
    const opts = piCreate.mock.calls[0]?.[1];
    expect(opts).toMatchObject({ stripeAccount: "acct_tenant" });
  });
});
