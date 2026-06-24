// sendSubscriptionBillingNoticeOrThrow / maybeSendSubscriptionBillingNotice
// — Stripe-customer → shop_customer resolution + outcome-to-error mapping.
//
// The email builder is mocked at its module boundary so we don't stage the
// SendGrid stack; supabase is mocked to control the shop_customers lookup.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn();
vi.mock("../order-emails/send-subscription-billing-email", () => ({
  sendSubscriptionBillingEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

import {
  maybeSendSubscriptionBillingNotice,
  sendSubscriptionBillingNoticeOrThrow,
} from "./subscription-billing-notice";

const ORG = "11111111-1111-4111-8111-111111111111";

function baseInput() {
  return {
    orgId: ORG,
    kind: "receipt" as const,
    stripeCustomerId: "cus_123",
    amountCents: 4999,
    currency: "usd",
    chargeDateIso: "2026-06-30T12:00:00Z",
  };
}

beforeEach(() => {
  supabaseMock.reset();
  sendEmailMock.mockReset();
});

describe("sendSubscriptionBillingNoticeOrThrow", () => {
  it("resolves the shop customer and sends the email", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    sendEmailMock.mockResolvedValue({ configured: true, delivered: true });

    await expect(
      sendSubscriptionBillingNoticeOrThrow(baseInput()),
    ).resolves.toBeUndefined();

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "buyer@example.com",
        kind: "receipt",
        amountCents: 4999,
        orgId: ORG,
      }),
    );
  });

  it("returns cleanly (no send) when no shop customer matches", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });

    await expect(
      sendSubscriptionBillingNoticeOrThrow(baseInput()),
    ).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns cleanly without a stripe customer id", async () => {
    await expect(
      sendSubscriptionBillingNoticeOrThrow({
        ...baseInput(),
        stripeCustomerId: null,
      }),
    ).resolves.toBeUndefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("returns cleanly when SendGrid is not configured", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    sendEmailMock.mockResolvedValue({ configured: false, delivered: false });

    await expect(
      sendSubscriptionBillingNoticeOrThrow(baseInput()),
    ).resolves.toBeUndefined();
  });

  it("throws on a SendGrid API failure so pg-boss retries", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    sendEmailMock.mockResolvedValue({
      configured: true,
      delivered: false,
      error: "SendGrid 503: upstream",
    });

    await expect(
      sendSubscriptionBillingNoticeOrThrow(baseInput()),
    ).rejects.toThrow(/send failed/);
  });
});

describe("maybeSendSubscriptionBillingNotice", () => {
  it("swallows the throw on the fire-and-forget fallback path", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "buyer@example.com" },
    });
    sendEmailMock.mockResolvedValue({
      configured: true,
      delivered: false,
      error: "SendGrid 429: rate limited",
    });

    await expect(
      maybeSendSubscriptionBillingNotice(baseInput()),
    ).resolves.toBeUndefined();
  });
});
