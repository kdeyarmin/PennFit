// Unit tests for sendSubscriptionBillingEmail + format helpers.
//
// SendGrid is mocked at the module boundary (createTenantSendgridClient
// delegates to createSendgridClient). Branding/base-url are stubbed for
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

import {
  formatBillingAmount,
  formatBillingDate,
  sendSubscriptionBillingEmail,
} from "./send-subscription-billing-email";

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SHOP_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

describe("formatBillingAmount / formatBillingDate", () => {
  it("formats USD cents as $X.XX", () => {
    expect(formatBillingAmount(4999, "usd")).toBe("$49.99");
    expect(formatBillingAmount(4999, "USD")).toBe("$49.99");
  });
  it("formats non-USD with the currency code", () => {
    expect(formatBillingAmount(1000, "eur")).toBe("10.00 EUR");
  });
  it("falls back when the amount is null", () => {
    expect(formatBillingAmount(null, "usd")).toBe("your balance");
  });
  it("formats an ISO date deterministically (UTC, en-US)", () => {
    expect(formatBillingDate("2026-06-30T12:00:00Z")).toBe("June 30, 2026");
  });
  it("returns null for missing/invalid dates", () => {
    expect(formatBillingDate(null)).toBeNull();
    expect(formatBillingDate("not-a-date")).toBeNull();
  });
});

describe("sendSubscriptionBillingEmail", () => {
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
    const result = await sendSubscriptionBillingEmail({
      toEmail: "buyer@example.com",
      kind: "receipt",
      amountCents: 4999,
      currency: "usd",
    });
    expect(result.configured).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("renewing_soon: advance notice with date, amount, and manage link", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_soon" });

    const result = await sendSubscriptionBillingEmail({
      toEmail: "buyer@example.com",
      kind: "renewing_soon",
      amountCents: 4999,
      currency: "usd",
      chargeDateIso: "2026-06-30T12:00:00Z",
    });

    expect(result).toEqual({
      configured: true,
      delivered: true,
      messageId: "msg_soon",
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toContain("renews");
    expect(arg.subject).toContain("June 30, 2026");
    expect(arg.html).toContain("Renewing soon");
    expect(arg.html).toContain("$49.99");
    expect(arg.html).toContain("https://test.example.com/account-billing");
    expect(arg.customArgs).toEqual({
      kind: "shop_subscription_renewing_soon_v1",
    });
  });

  it("receipt: payment-received confirmation with amount + manage link", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_receipt" });

    const result = await sendSubscriptionBillingEmail({
      toEmail: "buyer@example.com",
      kind: "receipt",
      amountCents: 4999,
      currency: "usd",
      chargeDateIso: "2026-06-30T12:00:00Z",
    });

    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toContain("receipt");
    expect(arg.html).toContain("Payment received");
    expect(arg.html).toContain("$49.99");
    expect(arg.html).toContain("https://test.example.com/account-billing");
    expect(arg.customArgs).toEqual({ kind: "shop_subscription_receipt_v1" });
  });

  it("brands with the tenant storefront name (G6)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    brandNameRef.value = "Acme CPAP";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_brand" });

    await sendSubscriptionBillingEmail({
      toEmail: "buyer@example.com",
      kind: "receipt",
      orgId: "11111111-1111-4111-8111-111111111111",
      amountCents: 4999,
      currency: "usd",
    });
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.html).toContain("Acme CPAP");
    expect(arg.subject).toContain("Acme CPAP");
    expect(arg.subject).not.toContain("Penn Home Medical Supply");
  });

  it("renders cleanly when the charge date is unknown", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_nodate" });

    const result = await sendSubscriptionBillingEmail({
      toEmail: "buyer@example.com",
      kind: "renewing_soon",
      amountCents: 4999,
      currency: "usd",
      chargeDateIso: null,
    });
    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.subject).toContain("soon");
  });
});
