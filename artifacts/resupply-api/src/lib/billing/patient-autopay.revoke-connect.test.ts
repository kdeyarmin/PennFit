// revokeAutopayAuthorization — Stripe Connect routing for PM detach.
// The saved PaymentMethod for a connected-account setup lives ON that
// account (the setup session + autopay-charge worker both route there),
// so detach() must carry the tenant's `{ stripeAccount }` or Stripe 404s
// the PM on the platform account and the card stays attached after the
// patient removed it. Platform account → `{}`, unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const detach = vi.hoisted(() => vi.fn());
vi.mock("../stripe/config", () => ({
  getStripeClient: () => ({
    paymentMethods: { detach },
  }),
  readStripeConfigOrNull: () => ({ secretKey: "sk_test_x" }),
}));

const acctOpts = vi.hoisted(() => ({
  value: {} as { stripeAccount?: string },
}));
vi.mock("../stripe/connect", () => ({
  stripeAccountRequestOptions: vi.fn(async () => acctOpts.value),
}));

import { revokeAutopayAuthorization } from "./patient-autopay";

beforeEach(() => {
  supabaseMock.reset();
  acctOpts.value = {};
  detach.mockReset();
  detach.mockResolvedValue({});
  // Active authorization row → revoke path.
  stageSupabaseResponse("patient_autopay_authorizations", "select", {
    data: { id: "auth-1", stripe_payment_method_id: "pm_1", created_by: null },
  });
  stageSupabaseResponse("patient_autopay_authorizations", "update", {
    data: { id: "auth-1" },
  });
});

describe("revokeAutopayAuthorization — Connect routing", () => {
  it("detaches the PM on the tenant's connected account", async () => {
    acctOpts.value = { stripeAccount: "acct_tenant" };

    const result = await revokeAutopayAuthorization("org-x", "pat-1", null);

    expect(result).toEqual({ ok: true });
    // detach(id, params?, options?) — options is the SDK's THIRD arg.
    expect(detach).toHaveBeenCalledWith("pm_1", undefined, {
      stripeAccount: "acct_tenant",
    });
  });

  it("detaches on the platform account when the tenant has none", async () => {
    acctOpts.value = {};
    await revokeAutopayAuthorization("org-x", "pat-1", null);
    expect(detach).toHaveBeenCalledWith("pm_1", undefined, {});
  });

  it("still revokes locally when detach throws (non-fatal)", async () => {
    detach.mockRejectedValueOnce(new Error("No such PaymentMethod"));
    const result = await revokeAutopayAuthorization("org-x", "pat-1", null);
    expect(result).toEqual({ ok: true });
  });
});
