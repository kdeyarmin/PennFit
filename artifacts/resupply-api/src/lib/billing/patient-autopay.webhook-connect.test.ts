// recordAutopayAuthorization — Stripe Connect routing for the patient-autopay
// mode=setup webhook. The SetupIntent + PaymentMethod for a connected-account
// setup live ON that account, so both retrieves must carry the tenant's
// `{ stripeAccount }`. The tenant is resolved from the webhook event
// (resolveWebhookOrgId), not the seed org. Platform account → `{}`, unchanged.

import type Stripe from "stripe";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const retrieveSetupIntent = vi.hoisted(() => vi.fn());
const retrievePaymentMethod = vi.hoisted(() => vi.fn());
vi.mock("../stripe/config", () => ({
  getStripeClient: () => ({
    setupIntents: { retrieve: retrieveSetupIntent },
    paymentMethods: { retrieve: retrievePaymentMethod },
  }),
  readStripeConfigOrNull: () => ({ secretKey: "sk_test_x" }),
}));

const resolveWebhookOrgId = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => "org-x"),
);
vi.mock("../stripe/webhook-org-context", () => ({ resolveWebhookOrgId }));

const acctOpts = vi.hoisted(() => ({
  value: {} as { stripeAccount?: string },
}));
vi.mock("../stripe/connect", () => ({
  stripeAccountRequestOptions: vi.fn(async () => acctOpts.value),
}));

import { recordAutopayAuthorization } from "./patient-autopay";

function fakeSession(): Stripe.Checkout.Session {
  return {
    metadata: {
      patient_id: "pat-1",
      purpose: "patient_autopay_setup",
      enable_autopay: "1",
      shop_customer_id: "cust-1",
    },
    customer: "cus_1",
    setup_intent: "seti_1",
  } as unknown as Stripe.Checkout.Session;
}

beforeEach(() => {
  supabaseMock.reset();
  acctOpts.value = {};
  retrieveSetupIntent.mockReset();
  retrieveSetupIntent.mockResolvedValue({ payment_method: "pm_1" });
  retrievePaymentMethod.mockReset();
  retrievePaymentMethod.mockResolvedValue({
    card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 },
  });
  resolveWebhookOrgId.mockClear();
  // No existing authorization → insert path.
  stageSupabaseResponse("patient_autopay_authorizations", "select", {
    data: null,
  });
  stageSupabaseResponse("patient_autopay_authorizations", "insert", {
    data: { id: "auth-1" },
  });
});

describe("recordAutopayAuthorization — Connect routing", () => {
  it("retrieves SetupIntent + PaymentMethod on the tenant's connected account", async () => {
    acctOpts.value = { stripeAccount: "acct_tenant" };

    await recordAutopayAuthorization({} as never, fakeSession(), undefined);

    // Request options are the SDK's THIRD arg on retrieve(id, params?, options?).
    expect(retrieveSetupIntent).toHaveBeenCalledWith("seti_1", undefined, {
      stripeAccount: "acct_tenant",
    });
    expect(retrievePaymentMethod).toHaveBeenCalledWith("pm_1", undefined, {
      stripeAccount: "acct_tenant",
    });
  });

  it("retrieves on the platform account when the tenant has none", async () => {
    acctOpts.value = {};
    await recordAutopayAuthorization({} as never, fakeSession(), undefined);
    expect(retrieveSetupIntent).toHaveBeenCalledWith("seti_1", undefined, {});
  });

  it("resolves the tenant from the webhook event, not the seed org", async () => {
    await recordAutopayAuthorization({} as never, fakeSession(), undefined);
    expect(resolveWebhookOrgId).toHaveBeenCalledTimes(1);
  });

  it("throws when the webhook tenant can't be resolved (no retrieve)", async () => {
    resolveWebhookOrgId.mockResolvedValueOnce(null);
    await expect(
      recordAutopayAuthorization({} as never, fakeSession(), undefined),
    ).rejects.toThrow(/tenant context missing/);
    expect(retrieveSetupIntent).not.toHaveBeenCalled();
  });
});
