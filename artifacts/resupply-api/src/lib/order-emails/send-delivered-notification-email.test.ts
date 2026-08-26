// Unit tests for sendDeliveredNotificationEmail.
//
// SendGrid is mocked at the module boundary (same pattern as
// send-shipping-notification-email.test.ts): createTenantSendgridClient
// delegates to createSendgridClient under the hood, so stubbing the
// latter intercepts the send. Branding is stubbed for deterministic copy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SavedShippingAddress } from "@workspace/resupply-db";

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
  resolveTenantLinkBaseUrl: vi.fn(async (_orgId: string, platform: string) => platform),
}));

import { EmailConfigError } from "@workspace/resupply-email";

import { sendDeliveredNotificationEmail } from "./send-delivered-notification-email";

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SHOP_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

const ADDR: SavedShippingAddress = {
  line1: "100 Main St",
  line2: "Apt 4B",
  city: "Springfield",
  state: "IL",
  postalCode: "62704",
  country: "US",
};

describe("sendDeliveredNotificationEmail", () => {
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
    const result = await sendDeliveredNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_1",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      shippingAddress: ADDR,
    });
    expect(result.configured).toBe(false);
    expect(result.delivered).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("delivers happy path with delivered subject + tracking link", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_del_1" });

    const result = await sendDeliveredNotificationEmail({
      toEmail: "Buyer@Example.com",
      stripeSessionId: "cs_del",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      shippingAddress: ADDR,
    });

    expect(result).toEqual({
      configured: true,
      delivered: true,
      messageId: "msg_del_1",
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe(
      "Your Penn Home Medical Supply order was delivered",
    );
    // The shared layout HTML-escapes headings, so the apostrophe rides
    // as a numeric entity (renders identically in every mail client).
    expect(arg.html).toContain("It&#39;s here");
    expect(arg.html).toContain("ups.com/track");
    expect(arg.html).toContain("1Z999AA10123456784");
    expect(arg.html).toContain("Apt 4B");
    expect(arg.text).toContain("Carrier:  UPS");
    expect(arg.text).toContain("Tracking: 1Z999AA10123456784");
    expect(arg.customArgs).toEqual({
      kind: "shop_delivered_notification_v1",
      stripe_session_id: "cs_del",
    });
  });

  it("renders cleanly with NO tracking (webhook-driven delivery)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_del_notrack" });

    const result = await sendDeliveredNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_notrack",
      carrier: null,
      trackingNumber: null,
      shippingAddress: ADDR,
    });

    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    // No tracking box / "Delivered by" section, no carrier lines in text.
    expect(arg.html).not.toContain("Delivered by");
    expect(arg.text).not.toContain("Tracking:");
    // Still has the contact CTA + address (cash-pay order pages retired).
    expect(arg.html).toContain("Contact us");
    expect(arg.html).toContain("/contact");
    expect(arg.html).toContain("Apt 4B");
  });

  it("brands the email with the tenant's storefront name (G6)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    brandNameRef.value = "Acme CPAP";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_del_brand" });

    await sendDeliveredNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_del_brand",
      orgId: "11111111-1111-4111-8111-111111111111",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      shippingAddress: ADDR,
    });

    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your Acme CPAP order was delivered");
    expect(arg.html).toContain("Acme CPAP");
    expect(arg.subject).not.toContain("Penn Home Medical Supply");
  });

  it("escapes hostile carrier/tracking values into the body", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_del_xss" });

    await sendDeliveredNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_xss",
      carrier: "<img onerror=x>",
      trackingNumber: "<script>1</script>",
      shippingAddress: null,
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).not.toContain("<img onerror");
    expect(arg.html).not.toContain("<script>1");
    expect(arg.html).toContain("&lt;script&gt;");
  });

  it("renders cleanly with no shipping address", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_del_noaddr" });

    const result = await sendDeliveredNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_noaddr",
      carrier: "USPS",
      trackingNumber: "9400111899223123456784",
      shippingAddress: null,
    });
    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).not.toContain("Delivered to");
    expect(arg.text).not.toContain("Delivered to:");
  });
});
