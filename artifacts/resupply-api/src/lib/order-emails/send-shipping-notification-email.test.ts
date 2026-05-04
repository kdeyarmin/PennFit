// Unit tests for sendShippingNotificationEmail + getCarrierTrackingUrl.
//
// SendGrid is mocked at module boundary (same pattern as
// send-order-confirmation-email.test.ts). Tracking-URL mapping is
// pure and can be asserted directly.

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

import { EmailConfigError } from "@workspace/resupply-email";

import {
  getCarrierTrackingUrl,
  sendShippingNotificationEmail,
} from "./send-shipping-notification-email";

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

describe("getCarrierTrackingUrl", () => {
  it.each([
    ["UPS", "1Z999AA10123456784", "https://www.ups.com/track?tracknum="],
    ["ups", "1Z999AA10123456784", "https://www.ups.com/track?tracknum="],
    ["U.P.S.", "1Z999AA10123456784", "https://www.ups.com/track?tracknum="],
    [
      "USPS",
      "9400111899223123456784",
      "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
    ],
    ["FedEx", "794613527122", "https://www.fedex.com/fedextrack/?trknbr="],
    [
      "Federal Express",
      "794613527122",
      "https://www.fedex.com/fedextrack/?trknbr=",
    ],
    ["DHL", "1234567890", "https://www.dhl.com/en/express/tracking.html?AWB="],
    [
      "DHL Express",
      "1234567890",
      "https://www.dhl.com/en/express/tracking.html?AWB=",
    ],
  ])("maps %s → known URL template", (carrier, num, prefix) => {
    const url = getCarrierTrackingUrl(carrier, num);
    expect(url).not.toBeNull();
    expect(url!.startsWith(prefix)).toBe(true);
    // Tracking number must be url-encoded into the query string.
    expect(url!.includes(encodeURIComponent(num))).toBe(true);
  });

  it("returns null for unknown carriers", () => {
    expect(getCarrierTrackingUrl("OnTrac", "ABC123")).toBeNull();
    expect(getCarrierTrackingUrl("LaserShip", "XYZ")).toBeNull();
  });

  it("returns null when tracking number is empty", () => {
    expect(getCarrierTrackingUrl("UPS", "   ")).toBeNull();
  });
});

describe("sendShippingNotificationEmail", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
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
    const result = await sendShippingNotificationEmail({
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

  it("delivers happy path with UPS tracking URL embedded in body", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_1" });

    const result = await sendShippingNotificationEmail({
      toEmail: "Buyer@Example.com",
      stripeSessionId: "cs_ship",
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      shippingAddress: ADDR,
    });

    expect(result).toEqual({
      configured: true,
      delivered: true,
      messageId: "msg_ship_1",
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toBe("Your PennPaps order has shipped");
    expect(arg.html).toContain("ups.com/track");
    expect(arg.html).toContain("1Z999AA10123456784");
    expect(arg.html).toContain("Apt 4B");
    expect(arg.text).toContain("Carrier:  UPS");
    expect(arg.text).toContain("Tracking: 1Z999AA10123456784");
    expect(arg.customArgs).toEqual({
      kind: "shop_shipping_notification_v1",
      stripe_session_id: "cs_ship",
    });
  });

  it("falls back to bare tracking number when carrier is unknown", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_unk" });

    const result = await sendShippingNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_unk",
      carrier: "OnTrac",
      trackingNumber: "ABC123",
      shippingAddress: ADDR,
    });
    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    // Tracking number renders as text; no "Track package" CTA.
    expect(arg.html).toContain("ABC123");
    expect(arg.html).not.toContain("Track package");
    // Fallback CTA goes to the order page.
    expect(arg.html).toContain("View order");
  });

  it("escapes hostile carrier/tracking values into the body", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_xss" });

    await sendShippingNotificationEmail({
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
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_ship_noaddr" });

    const result = await sendShippingNotificationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_noaddr",
      carrier: "USPS",
      trackingNumber: "9400111899223123456784",
      shippingAddress: null,
    });
    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).not.toContain("Shipping to");
    expect(arg.text).not.toContain("Shipping to:");
  });
});
