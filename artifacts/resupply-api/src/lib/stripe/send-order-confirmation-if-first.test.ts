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
// Mocking strategy: Drizzle is replaced by a fluent stub. SELECTs
// pull from `selectQueue`, atomic-claim UPDATEs (those terminating in
// `.returning()`) pull from `updateReturningQueue`. SendGrid is
// mocked at the @workspace/resupply-email module boundary.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";

// Each call to db.select() / db.update() returns a fresh fluent that
// resolves with whatever sits at the head of the corresponding queue.
// `.returning()` and `.limit()` are the chain terminators; both yield
// a Promise<rows>. `.then()` on the fluent itself supports the bare
// `await db.update(...).set(...).where(...)` pattern (no terminator).
// A select queue entry is normally an array of row objects, but for
// transient-failure tests we also accept an Error sentinel — when the
// fluent terminates (`.limit()` or bare `await`) it rejects with that
// error instead of resolving rows. This lets us pin the post-claim
// release behaviour for transient DB lookup failures.
type SelectQueueEntry = unknown[] | Error;
const selectQueue: SelectQueueEntry[] = [];
const updateReturningQueue: unknown[][] = [];
const updateBareCalls: { count: number } = { count: 0 };

function selectFluent(): Record<string, unknown> {
  const head = selectQueue.shift();
  const settle = (): Promise<unknown[]> =>
    head instanceof Error ? Promise.reject(head) : Promise.resolve(head ?? []);
  const obj: Record<string, unknown> = {
    from: () => obj,
    where: () => obj,
    limit: () => settle(),
    then: (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => settle().then(resolve, reject),
  };
  return obj;
}
function updateFluent(): Record<string, unknown> {
  // The atomic-claim path terminates in `.returning(...)`. The
  // claim-release / bare-stamp paths terminate by awaiting the
  // chain itself (no `.returning()`).
  let returningCalled = false;
  const obj: Record<string, unknown> = {
    set: () => obj,
    where: () => obj,
    returning: () => {
      returningCalled = true;
      const rows = updateReturningQueue.shift() ?? [];
      return Promise.resolve(rows);
    },
    then: (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => {
      if (!returningCalled) updateBareCalls.count += 1;
      return Promise.resolve(undefined).then(resolve, reject);
    },
  };
  return obj;
}

const dbStub = {
  select: vi.fn(() => selectFluent()),
  update: vi.fn(() => updateFluent()),
  insert: vi.fn(() => updateFluent()),
};
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => dbStub }));

vi.mock("@workspace/resupply-db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-db")>(
      "@workspace/resupply-db",
    );
  return { ...actual, getDbPool: () => ({}) as never };
});

const sendEmailMock = vi.fn();
const createSendgridClientMock = vi.fn<() => { sendEmail: typeof sendEmailMock }>(
  () => ({ sendEmail: sendEmailMock }),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-email")>(
    "@workspace/resupply-email",
  );
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

function makeSession(over: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    id: "cs_test_X",
    object: "checkout.session",
    amount_total: 9000,
    currency: "usd",
    customer_details: { email: "guest@example.com" } as unknown as Stripe.Checkout.Session["customer_details"],
    ...over,
  } as unknown as Stripe.Checkout.Session;
}

function claimedOrderRow(over: Record<string, unknown> = {}) {
  return {
    id: "ord_aaa",
    stripeSessionId: "cs_test_X",
    customerId: "user_alice",
    amountTotalCents: 9000,
    currency: "usd",
    shippingAddress: null,
    customerEmail: null,
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
    selectQueue.length = 0;
    updateReturningQueue.length = 0;
    updateBareCalls.count = 0;
    dbStub.select.mockClear();
    dbStub.update.mockClear();
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

    updateReturningQueue.push([claimedOrderRow()]); // atomic CLAIM wins
    selectQueue.push([{ email: "alice@example.com" }]); // shop_customers lookup
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
    // Exactly ONE UPDATE — the atomic claim. No release; success
    // path does not need to re-stamp.
    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(updateBareCalls.count).toBe(0);
  });

  it("does NOT resend on Stripe re-delivery — atomic claim returns no rows", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Empty returning() result simulates the prior worker having
    // already stamped confirmation_email_sent_at.
    updateReturningQueue.push([]);

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
    // The single UPDATE was the (failed) claim attempt; no SELECT,
    // no release.
    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(dbStub.select).not.toHaveBeenCalled();
    expect(updateBareCalls.count).toBe(0);
  });

  it("falls back to session.customer_details.email for guest checkouts (no customer_id, no persisted customer_email)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // customerId null AND customerEmail null → skip both lookups,
    // fall back to the Stripe-provided email on the Session.
    updateReturningQueue.push([
      claimedOrderRow({ customerId: null, customerEmail: null }),
    ]);
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
    // Customer lookup skipped (customerId null), so no SELECTs.
    expect(dbStub.select).not.toHaveBeenCalled();
    // One UPDATE — the atomic claim. No release.
    expect(dbStub.update).toHaveBeenCalledTimes(1);
    expect(updateBareCalls.count).toBe(0);
  });

  it("uses persisted customer_email for guest checkouts when present", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Guest with persisted customer_email — preferred over the
    // Stripe Session fallback so the source of truth is the row we
    // captured at paid-time.
    updateReturningQueue.push([
      claimedOrderRow({
        customerId: null,
        customerEmail: "persisted@example.com",
      }),
    ]);
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

    updateReturningQueue.push([claimedOrderRow()]); // claim wins
    selectQueue.push([{ email: "alice@example.com" }]);
    // sendEmail rejects → resupply-email helper returns
    // { delivered: false, error: '...' }
    sendEmailMock.mockRejectedValueOnce(new Error("upstream 503"));

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: false });
    // Two UPDATEs total: 1) atomic claim (with returning),
    // 2) release (bare set...where, no returning).
    expect(dbStub.update).toHaveBeenCalledTimes(2);
    expect(updateBareCalls.count).toBe(1);
  });

  it("RELEASES the claim when SendGrid is not configured (createSendgridClient throws)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    updateReturningQueue.push([claimedOrderRow()]);
    selectQueue.push([{ email: "alice@example.com" }]);
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
    expect(dbStub.update).toHaveBeenCalledTimes(2);
    expect(updateBareCalls.count).toBe(1);
  });

  it("RELEASES the claim when the post-claim customer lookup throws (transient DB failure)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    // Claim wins, then the shop_customers SELECT rejects with a
    // transient pg error. The outer try/catch must still release the
    // stamp so a future redelivery can retry — otherwise a single
    // hiccup would permanently suppress the confirmation email.
    updateReturningQueue.push([claimedOrderRow()]);
    selectQueue.push(new Error("ECONNRESET while reading shop_customers"));

    const result = await sendOrderConfirmationIfFirst({
      session: makeSession(),
      paidOrderId: "ord_aaa",
      items: [],
      log: makeLog(),
    });

    expect(result).toEqual({ skipped: false, delivered: false });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Two UPDATEs total: 1) atomic claim, 2) catch-all release.
    expect(dbStub.update).toHaveBeenCalledTimes(2);
    expect(updateBareCalls.count).toBe(1);
  });

  it("RELEASES the claim when no recipient can be resolved (no customer, no persisted email, no Stripe email)", async () => {
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "no-reply@penn.example";

    updateReturningQueue.push([
      claimedOrderRow({ customerId: null, customerEmail: null }),
    ]);
    const session = makeSession({
      customer_details: null as unknown as Stripe.Checkout.Session["customer_details"],
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
    expect(dbStub.update).toHaveBeenCalledTimes(2);
    expect(updateBareCalls.count).toBe(1);
  });
});
