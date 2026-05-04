// Unit tests for sendOrderConfirmationEmail.
//
// We mock the SendGrid client factory at module boundary so the
// helper under test is exercised with its real escaping / formatting
// / branching logic but never actually opens a network socket.
//
// Pattern matches abandoned-carts.test.ts so a future refactor can
// be confident the contract is the same across email helpers.

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

import { EmailApiError, EmailConfigError } from "@workspace/resupply-email";

import { sendOrderConfirmationEmail } from "./send-order-confirmation-email";

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
  line2: null,
  city: "Springfield",
  state: "IL",
  postalCode: "62704",
  country: "US",
};

describe("sendOrderConfirmationEmail", () => {
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
    // Make the factory throw EmailConfigError to simulate missing env;
    // the helper must convert that into a tagged-union outcome rather
    // than propagating — Stripe must not retry the webhook because
    // SendGrid was never wired up in this environment.
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY is not set");
    });
    const result = await sendOrderConfirmationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_test_1",
      items: [],
      amountTotalCents: 4500,
      currency: "usd",
      shippingAddress: ADDR,
    });
    expect(result.configured).toBe(false);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("SENDGRID_API_KEY");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("delivers happy path with messageId, escapes hostile product names, formats USD", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_123" });

    const result = await sendOrderConfirmationEmail({
      toEmail: "Buyer@Example.com",
      stripeSessionId: "cs_test_xss",
      items: [
        {
          name: "<script>alert('x')</script> Mask",
          quantity: 2,
          unitAmountCents: 4500,
          currency: "usd",
        },
      ],
      amountTotalCents: 9000,
      currency: "usd",
      shippingAddress: ADDR,
    });

    expect(result).toEqual({
      configured: true,
      delivered: true,
      messageId: "msg_123",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.to).toBe("Buyer@Example.com");
    expect(arg.subject).toBe("Your PennPaps order is confirmed");
    // HTML must be escaped, raw <script> must NOT appear.
    expect(arg.html).not.toContain("<script>alert");
    expect(arg.html).toContain("&lt;script&gt;");
    // Currency formatting (Intl renders "$" for USD).
    expect(arg.html).toContain("$45.00");
    expect(arg.html).toContain("$90.00");
    // Custom args route the SendGrid Event Webhook to the right handler.
    expect(arg.customArgs).toEqual({
      kind: "shop_order_confirmation_v1",
      stripe_session_id: "cs_test_xss",
    });
    // Address rendered.
    expect(arg.html).toContain("100 Main St");
    expect(arg.html).toContain("Springfield, IL 62704");
  });

  it("returns delivered=false with error string on SendGrid 4xx (no throw)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockRejectedValueOnce(
      new EmailApiError("Bad Request", 400, { errors: [] }),
    );

    const result = await sendOrderConfirmationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_test_4xx",
      items: [],
      amountTotalCents: 4500,
      currency: "usd",
      shippingAddress: ADDR,
    });
    expect(result.configured).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("400");
  });

  it("renders cleanly with no shipping address and an empty item list", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_empty" });

    const result = await sendOrderConfirmationEmail({
      toEmail: "buyer@example.com",
      stripeSessionId: "cs_test_empty",
      items: [],
      amountTotalCents: 0,
      currency: "usd",
      shippingAddress: null,
    });
    expect(result.delivered).toBe(true);
    const arg = sendEmailMock.mock.calls[0]![0];
    // Fallback summary copy is present when there are no items.
    expect(arg.html).toContain("itemised order is available online");
    // No "Shipping to" block when address is null.
    expect(arg.html).not.toContain("Shipping to");
    // Plain-text body still includes total + view-order link.
    expect(arg.text).toContain("Total: $0.00");
    expect(arg.text).toContain(
      "/shop/checkout-success?session_id=cs_test_empty",
    );
  });
});
