// Unit tests for sendRefundNotificationEmail.
//
// SendGrid is mocked at the module boundary (createTenantSendgridClient
// delegates to createSendgridClient); branding/base-url stubbed for
// deterministic copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendEmailMock = vi.fn();
const createSendgridClientMock = vi.fn<
  () => { sendEmail: typeof sendEmailMock }
>(() => ({ sendEmail: sendEmailMock }));
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => createSendgridClientMock(),
  };
});

const brandNameRef = vi.hoisted(() => ({ value: "Penn Home Medical Supply" }));
vi.mock("../tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: brandNameRef.value,
    legalName: brandNameRef.value,
    tagline: "tagline",
    logoUrl: null,
  })),
  resolveTenantBaseUrl: vi.fn(async () => null),
}));

import { EmailConfigError } from "@workspace/resupply-email";

import { sendRefundNotificationEmail } from "./send-refund-notification-email";

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SHOP_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("sendRefundNotificationEmail", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
    brandNameRef.value = "Penn Home Medical Supply";
    sendEmailMock.mockReset();
    createSendgridClientMock.mockReset();
    createSendgridClientMock.mockImplementation(() => ({
      sendEmail: sendEmailMock,
    }));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("returns configured=false when SendGrid env is missing (no throw)", async () => {
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY is not set");
    });
    const result = await sendRefundNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_1",
      amountRefundedCents: 4999,
      currency: "usd",
      isPartial: false,
    });
    expect(result.configured).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("full refund: refunded subject + amount + order link", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_full" });

    const result = await sendRefundNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_full",
      amountRefundedCents: 4999,
      currency: "usd",
      isPartial: false,
    });

    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe(
      "Your Penn Home Medical Supply order was refunded",
    );
    expect(arg.html).toContain("Refund issued");
    expect(arg.html).toContain("$49.99");
    expect(arg.html).toContain("https://test.example.com/track-order");
    expect(arg.customArgs).toEqual({
      kind: "shop_refund_notification_v1",
      stripe_session_id: "cs_full",
    });
  });

  it("partial refund: partial subject + 'partial refund' copy", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_partial" });

    const result = await sendRefundNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_partial",
      amountRefundedCents: 1000,
      currency: "usd",
      isPartial: true,
    });

    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toContain("partial refund");
    expect(arg.html).toContain("Partial refund issued");
    expect(arg.html).toContain("$10.00");
  });

  it("links to /track-order when there is no session id", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_nosess" });

    await sendRefundNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: null,
      amountRefundedCents: 4999,
      currency: "usd",
      isPartial: false,
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).toContain("https://test.example.com/track-order");
    expect(arg.html).not.toContain("/account/orders");
    // No stripe_session_id customArg when the session is unknown.
    expect(arg.customArgs).toEqual({ kind: "shop_refund_notification_v1" });
  });

  it("brands with the tenant storefront name (G6)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    brandNameRef.value = "Acme CPAP";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_brand" });

    await sendRefundNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_brand",
      orgId: "11111111-1111-4111-8111-111111111111",
      amountRefundedCents: 4999,
      currency: "usd",
      isPartial: false,
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your Acme CPAP order was refunded");
    expect(arg.subject).not.toContain("Penn Home Medical Supply");
  });
});
