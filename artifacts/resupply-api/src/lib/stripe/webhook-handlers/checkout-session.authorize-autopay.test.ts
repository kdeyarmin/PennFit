// authorizePaymentPlanAutopay — Stripe Connect routing for the mode=setup
// payment-plan autopay webhook. The SetupIntent (and the stored customer +
// PM) for a connected-account setup live ON that account, so the retrieve
// must carry the tenant's `{ stripeAccount }`. Single-tenant (no connected
// account) resolves to `{}` and retrieves on the platform account, unchanged.

import type Stripe from "stripe";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const retrieveSetupIntent = vi.hoisted(() => vi.fn());
vi.mock("../config", () => ({
  getStripeClient: () => ({
    setupIntents: { retrieve: retrieveSetupIntent },
  }),
}));

const resolveWebhookOrgId = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => "org-x"),
);
vi.mock("../webhook-org-context", () => ({ resolveWebhookOrgId }));

const acctOpts = vi.hoisted(() => ({
  value: {} as { stripeAccount?: string },
}));
vi.mock("../connect", () => ({
  stripeAccountRequestOptions: vi.fn(async () => acctOpts.value),
}));

import { authorizePaymentPlanAutopay } from "./checkout-session";

function fakeSession(): Stripe.Checkout.Session {
  return {
    metadata: { payment_plan_id: "plan-1", purpose: "payment_plan_autopay" },
    customer: "cus_1",
    setup_intent: "seti_1",
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  supabaseMock.reset();
  acctOpts.value = {};
  retrieveSetupIntent.mockReset();
  retrieveSetupIntent.mockResolvedValue({ payment_method: "pm_1" });
  resolveWebhookOrgId.mockClear();
  stageSupabaseResponse("patient_payment_plans", "update", { data: [] });
});

describe("authorizePaymentPlanAutopay — Connect routing", () => {
  it("retrieves the SetupIntent on the tenant's connected account", async () => {
    acctOpts.value = { stripeAccount: "acct_tenant" };

    await authorizePaymentPlanAutopay({} as never, fakeSession(), undefined);

    expect(retrieveSetupIntent).toHaveBeenCalledTimes(1);
    // Stripe SDK: retrieve(id, params?, options?) — request options are the
    // THIRD argument, so the connected account must land there.
    expect(retrieveSetupIntent).toHaveBeenCalledWith("seti_1", undefined, {
      stripeAccount: "acct_tenant",
    });
    // The mandated customer + PM are stored on the plan.
    const update = getSupabaseWritePayloads(
      "patient_payment_plans",
      "update",
    )[0] as Record<string, unknown>;
    expect(update).toMatchObject({
      autopay_status: "authorized",
      stripe_customer_id: "cus_1",
      stripe_payment_method_id: "pm_1",
    });
  });

  it("retrieves on the platform account when the tenant has no connected account", async () => {
    acctOpts.value = {};
    await authorizePaymentPlanAutopay({} as never, fakeSession(), undefined);
    expect(retrieveSetupIntent).toHaveBeenCalledWith("seti_1", undefined, {});
  });

  it("skips (no retrieve) when the webhook tenant can't be resolved", async () => {
    resolveWebhookOrgId.mockResolvedValueOnce(null);
    await authorizePaymentPlanAutopay({} as never, fakeSession(), undefined);
    expect(retrieveSetupIntent).not.toHaveBeenCalled();
    expect(getSupabaseWritePayloads("patient_payment_plans", "update")).toEqual(
      [],
    );
  });
});
