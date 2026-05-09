// Integration test for sendOrderConfirmationIfFirst — the helper
// invoked from the checkout.session.completed branch of the Stripe
// webhook handler.
//
// We exercise it directly (the function is exported precisely for
// this) rather than through the full webhook entry point, which
// would require Stripe signature construction and is overkill for
// the idempotency contract we want to pin.
//
// Coverage:
//   * First delivery → atomic CLAIM wins, confirmation email sent.
//                      The claim is the stamp (UPDATE … RETURNING),
//                      so on success NO additional UPDATEs are issued.
//   * Stripe re-delivery → atomic CLAIM returns no rows (timestamp
//                      already non-null), helper short-circuits.
//   * Guest checkout (customer_id null, customer_details.email
//                      present) → falls back to Stripe-provided email.
//   * SendGrid failure → claim is RELEASED (timestamp re-NULLED) so a
//                      future redelivery can retry.
//   * Concurrency: second worker losing the claim does not duplicate.
//
// Mocking strategy: Supabase service-role client is replaced via the
// shared test-helpers/supabase-mock helper. Per-test stages set the
// `(table, op)` queue (shop_orders update for the atomic claim and
// for any release; shop_customers select for the post-claim recipient
// lookup). Call-count invariants assert through the helper's
// `callCount(table, op)` so the original "exactly N updates" shape
// is preserved.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

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

import { sendOrderConfirmationIfFirst } from "./webhook-handler";

const ENV_KEYS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SHOP_PUBLIC_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string | undefined>> = {};

function makeSession(
  over: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
  return {
    id: "cs_test_X",
    object: "checkout.session",
    amount_total: 9000,
    currency: "usd",
    customer_details: {
      email: "guest@example.com",
    } as unknown as Stripe.Checkout.Session["customer_details"],
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

function claimedOrderRow(over: Record<string, unknown> = {}) {
  // Snake-case to match what PostgREST returns (the helper destructures
  // claimed.customer_id, claimed.stripe_session_id, etc.).
  return {
    id: "ord_aaa",
    stripe_session_id: "cs_test_X",
    customer_id: "user_alice",
    amount_total_cents: 9000,
    currency: "usd",
    shipping_address_json: null,
    customer_email: null,
    ...over,
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("sendOrderConfirmationIfFirst", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.SHOP_PUBLIC_BASE_URL = "https://test.example.com";
    supabaseMock.reset();
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

  it("claims the row atomically on first delivery and sends the confirmation email", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Atomic claim — UPDATE … RETURNING returns the canonical row.
    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow()],
    });
    // shop_customers lookup → linked email present.
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "alice@example.com" },
    });
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_first" });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [
        { name: "Mask", quantity: 2, unitAmountCents: 4500, currency: "usd" },
      ],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendEmailMock.mock.calls[0]![0];
    expect(arg.to).toBe("alice@example.com");
    expect(arg.subject).toBe("Your PennPaps order is confirmed");
    expect(arg.customArgs.kind).toBe("shop_order_confirmation_v1");
    expect(arg.customArgs.stripe_session_id).toBe("cs_test_X");
    // Exactly ONE UPDATE on shop_orders — the atomic claim. No
    // release on the success path.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(1);
  });

  it("does NOT resend on Stripe re-delivery — atomic claim returns no rows", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Empty array simulates the prior worker having already stamped
    // confirmation_email_sent_at.
    stageSupabaseResponse("shop_orders", "update", { data: [] });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({
      skipped: true,
      reason: "already_sent_or_missing",
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // The single UPDATE was the (failed) claim attempt; no shop_customers
    // lookup, no release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("falls back to session.customer_details.email for guest checkouts (no customer_id, no persisted customer_email)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // customer_id null AND customer_email null → skip both lookups,
    // fall back to the Stripe-provided email on the Session.
    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow({ customer_id: null, customer_email: null })],
    });
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_guest" });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: true });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe("guest@example.com");
    // Customer lookup skipped (customer_id null), so no SELECTs.
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
    // One UPDATE — the atomic claim. No release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(1);
  });

  it("uses persisted customer_email for guest checkouts when present", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Guest with persisted customer_email — preferred over the
    // Stripe Session fallback so the source of truth is the row we
    // captured at paid-time.
    stageSupabaseResponse("shop_orders", "update", {
      data: [
        claimedOrderRow({
          customer_id: null,
          customer_email: "persisted@example.com",
        }),
      ],
    });
    sendEmailMock.mockResolvedValueOnce({ messageId: "msg_persisted" });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: true });
    expect(sendEmailMock.mock.calls[0]![0].to).toBe("persisted@example.com");
  });

  it("RELEASES the claim when SendGrid returns a non-fatal error", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow()],
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "alice@example.com" },
    });
    // The release UPDATE — bare update().eq() with no select trailing.
    stageSupabaseResponse("shop_orders", "update", { error: null });
    sendEmailMock.mockRejectedValueOnce(new Error("upstream 503"));

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: false });
    // Two UPDATEs total: 1) atomic claim (with .select RETURNING),
    // 2) release (bare update().eq).
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
  });

  it("RELEASES the claim when SendGrid is not configured (createSendgridClient throws)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow()],
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { email_lower: "alice@example.com" },
    });
    stageSupabaseResponse("shop_orders", "update", { error: null });
    // Simulate the resupply-email helper's "not configured" path by
    // having createSendgridClient throw an EmailConfigError. The
    // helper catches it and returns `{ configured: false }` — this
    // helper must then RELEASE the claim so a later replay can retry.
    const { EmailConfigError } = await import("@workspace/resupply-email");
    createSendgridClientMock.mockImplementation(() => {
      throw new EmailConfigError("SENDGRID_API_KEY missing");
    });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: true, reason: "not_configured" });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Claim won then released → 2 UPDATEs.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
  });

  it("RELEASES the claim when the post-claim customer lookup throws (transient DB failure)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Claim wins, then the shop_customers SELECT returns an error
    // envelope (PostgREST surfaces transport failures here). The
    // outer try/catch must still release the stamp so a future
    // redelivery can retry — otherwise a single hiccup would
    // permanently suppress the confirmation email.
    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow()],
    });
    stageSupabaseResponse("shop_customers", "select", {
      error: new Error("ECONNRESET while reading shop_customers"),
    });
    stageSupabaseResponse("shop_orders", "update", { error: null });

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: false });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Two UPDATEs total: 1) atomic claim, 2) catch-all release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
  });

  it("RELEASES the claim when no recipient can be resolved (no customer, no persisted email, no Stripe email)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    stageSupabaseResponse("shop_orders", "update", {
      data: [claimedOrderRow({ customer_id: null, customer_email: null })],
    });
    stageSupabaseResponse("shop_orders", "update", { error: null });
    const session = makeSession({
      customer_details:
        null as unknown as Stripe.Checkout.Session["customer_details"],
    });

    const result = await sendOrderConfirmationIfFirst({
      session,
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: true, reason: "no_email_on_file" });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Claim won, but no recipient → release.
    expect(getSupabaseCallCount("shop_orders", "update")).toBe(2);
  });
});
