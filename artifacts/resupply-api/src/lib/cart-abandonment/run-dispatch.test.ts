// Unit tests for the cart-abandonment dispatcher (run-dispatch.ts).
//
// The dispatcher is the shared core between the admin "send-due" route
// and the hourly pg-boss cron. These tests exercise the full sweep
// logic — candidate selection, atomic claiming, comm-prefs gating, DND
// suppression, per-row send outcomes, error abort + unclaim, and the
// returned stats envelope.
//
// DB interactions are stubbed via the module-scope supabase-mock.
// sendCartAbandonmentEmail and isInDndWindow are vi.mock'd so each test
// controls exactly which outcome the send returns.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

// ─── Module-scope mocks (must be hoisted before any import of the SUT) ───

// Widen the mock's inferred return type to the full
// `SendCartAbandonmentEmailResult` shape so individual tests can
// stage envelopes that omit the optional `messageId` /  set the
// optional `error` field. The hoisted vi.fn() without an explicit
// generic infers from the initial implementation, which is the
// happy-path "delivered" envelope — using mockResolvedValueOnce
// with the failure / not-configured shapes would otherwise fail
// the strict-return-type check.
type SendCartAbandonmentEmailMockResult = {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
};
const sendCartAbandonmentEmailMock = vi.hoisted(() =>
  vi.fn<(_input: unknown) => Promise<SendCartAbandonmentEmailMockResult>>(
    async () => ({
      configured: true,
      delivered: true,
      messageId: "msg-1",
    }),
  ),
);
vi.mock("./send-cart-abandonment-email", () => ({
  sendCartAbandonmentEmail: sendCartAbandonmentEmailMock,
}));

const isInDndWindowMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../comm-prefs", () => ({
  isInDndWindow: isInDndWindowMock,
  resolveTimezone: vi.fn(() => "UTC"),
  shouldSendEmail: vi.fn(() => true),
  shouldSendSms: vi.fn(() => true),
}));

// Feature flag gate — defaults to enabled (true) so existing tests are
// unaffected. Set to false in the feature-gate describe block below.
const isFeatureEnabledMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../feature-flags", () => ({
  isFeatureEnabled: isFeatureEnabledMock,
}));

// ─── Install supabase mock (must happen before SUT import) ────────────────
const supabaseMock = installSupabaseMock();

// ─── SUT ─────────────────────────────────────────────────────────────────
import {
  runCartAbandonmentDispatch,
  CART_ABANDONMENT_NUDGE_WAIT_MS,
  CART_ABANDONMENT_SCAN_LIMIT,
} from "./run-dispatch";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeCartRow(
  over: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "cart-1",
    customer_id: "cust-1",
    email: "patient@example.com",
    items: [{ stripePriceId: "price_abc", quantity: 1, intervalMonths: 1 }],
    subtotal_cents: 2999,
    currency: "usd",
    ...over,
  };
}

function makePrefRow(
  customerId: string,
  prefs: Record<string, unknown> = {},
): Record<string, unknown> {
  return { customer_id: customerId, communication_preferences: prefs };
}

/**
 * Stage the three DB round-trips that a minimal single-row dispatch makes:
 *  1. SELECT candidates from shop_abandoned_carts
 *  2. UPDATE shop_abandoned_carts (claim)
 *  3. SELECT shop_customers (prefs)
 */
function stageMinimalDispatch(
  opts: {
    candidateIds?: string[];
    claimedRows?: Record<string, unknown>[];
    prefRows?: Record<string, unknown>[];
  } = {},
): void {
  const candidateIds = opts.candidateIds ?? ["cart-1"];
  const claimedRows = opts.claimedRows ?? [makeCartRow()];
  const prefRows = opts.prefRows ?? [];

  // 1. Candidates SELECT
  stageSupabaseResponse("shop_abandoned_carts", "select", {
    data: candidateIds.map((id) => ({ id })),
  });
  // 2. Claim UPDATE (returns claimed rows)
  stageSupabaseResponse("shop_abandoned_carts", "update", {
    data: claimedRows,
  });
  // 3. Prefs SELECT
  stageSupabaseResponse("shop_customers", "select", {
    data: prefRows,
  });
}

beforeEach(() => {
  supabaseMock.reset();
  sendCartAbandonmentEmailMock.mockClear();
  sendCartAbandonmentEmailMock.mockResolvedValue({
    configured: true,
    delivered: true,
    messageId: "msg-1",
  });
  isInDndWindowMock.mockClear();
  isInDndWindowMock.mockReturnValue(false);
  isFeatureEnabledMock.mockClear();
  isFeatureEnabledMock.mockResolvedValue(true);
});

// ─── Constants ────────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("CART_ABANDONMENT_NUDGE_WAIT_MS is exactly 24 hours", () => {
    expect(CART_ABANDONMENT_NUDGE_WAIT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("CART_ABANDONMENT_SCAN_LIMIT is 200", () => {
    expect(CART_ABANDONMENT_SCAN_LIMIT).toBe(200);
  });
});

// ─── Empty candidate set ──────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — no eligible candidates", () => {
  it("returns zero stats and makes no further DB calls when candidates list is empty", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: [] });

    const stats = await runCartAbandonmentDispatch();

    expect(stats).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    });
    // No claim UPDATE or prefs SELECT should happen.
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(0);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
  });

  it("returns zero stats when candidates query returns null data", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", { data: null });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.scanned).toBe(0);
    expect(stats.sent).toBe(0);
  });
});

// ─── DB error propagation ─────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — DB error propagation", () => {
  it("throws when the candidates SELECT fails", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      error: { message: "connection timeout", code: "57P01" },
    });

    await expect(runCartAbandonmentDispatch()).rejects.toMatchObject({
      message: "connection timeout",
    });
  });

  it("throws when the claim UPDATE fails", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: "cart-1" }],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      error: { message: "update conflict", code: "40001" },
    });

    await expect(runCartAbandonmentDispatch()).rejects.toMatchObject({
      message: "update conflict",
    });
  });

  it("throws when the prefs SELECT fails", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: "cart-1" }],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [makeCartRow()],
    });
    stageSupabaseResponse("shop_customers", "select", {
      error: { message: "prefs table offline", code: "99999" },
    });

    await expect(runCartAbandonmentDispatch()).rejects.toMatchObject({
      message: "prefs table offline",
    });
  });
});

// ─── Successful send ──────────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — successful send", () => {
  it("sends email and increments sent counter for an eligible row", async () => {
    stageMinimalDispatch();

    const stats = await runCartAbandonmentDispatch();

    expect(stats).toEqual({
      scanned: 1,
      sent: 1,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    });
    expect(sendCartAbandonmentEmailMock).toHaveBeenCalledTimes(1);
    expect(sendCartAbandonmentEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "patient@example.com",
      }),
    );
    // Successful send — no unclaim UPDATE beyond the claim UPDATE.
    // Only one update call total (the claim).
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(1);
  });

  it("sends emails for multiple eligible rows and counts all as sent", async () => {
    const candidateIds = ["cart-1", "cart-2", "cart-3"];
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: candidateIds.map((id) => ({ id })),
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      data: [
        makeCartRow({
          id: "cart-1",
          customer_id: "cust-1",
          email: "p1@ex.com",
        }),
        makeCartRow({
          id: "cart-2",
          customer_id: "cust-2",
          email: "p2@ex.com",
        }),
        makeCartRow({
          id: "cart-3",
          customer_id: "cust-3",
          email: "p3@ex.com",
        }),
      ],
    });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.scanned).toBe(3);
    expect(stats.sent).toBe(3);
    expect(stats.skippedOptOut).toBe(0);
    expect(stats.skippedFailed).toBe(0);
    expect(stats.skippedNoConfig).toBe(0);
    expect(sendCartAbandonmentEmailMock).toHaveBeenCalledTimes(3);
  });

  it("passes the injectable `now` to compute the cutoff timestamp", async () => {
    // Provide a known `now` and verify the function proceeds without error —
    // the cutoff calculation is internal, but we can confirm the dispatch
    // runs correctly with a pinned clock.
    const pinned = new Date("2026-05-20T12:00:00.000Z");
    stageMinimalDispatch();

    const stats = await runCartAbandonmentDispatch({ now: pinned });

    expect(stats.sent).toBe(1);
  });
});

// ─── Opt-out suppression ──────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — opt-out suppression", () => {
  it("unclaims and skips a row when emailAbandonedCart is false", async () => {
    stageMinimalDispatch({
      prefRows: [makePrefRow("cust-1", { emailAbandonedCart: false })],
    });
    // Stage the unclaim UPDATE.
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.scanned).toBe(1);
    expect(stats.skippedOptOut).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
    // Two update calls: claim + unclaim.
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(2);
    // The unclaim UPDATE should set reminded_at to null.
    const updates = getSupabaseWritePayloads("shop_abandoned_carts", "update");
    expect(updates[1]).toEqual({ reminded_at: null });
  });

  it("unclaims and skips a row when the customer is in a DND window", async () => {
    isInDndWindowMock.mockReturnValue(true);
    stageMinimalDispatch({
      prefRows: [makePrefRow("cust-1", { dndStartHour: 22, dndEndHour: 7 })],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.skippedOptOut).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
  });

  it("uses default prefs (emailAbandonedCart=true, no DND) when no customer row exists", async () => {
    // No prefs staged — the mock returns null, so mergePrefs(null) applies defaults.
    stageMinimalDispatch({ prefRows: [] });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.sent).toBe(1);
    expect(stats.skippedOptOut).toBe(0);
  });
});

// ─── Belt-and-suspenders null email guard ─────────────────────────────────

describe("runCartAbandonmentDispatch — null email guard", () => {
  it("unclaims and increments skippedFailed when email is null on a claimed row", async () => {
    stageMinimalDispatch({
      claimedRows: [makeCartRow({ email: null })],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    const stats = await runCartAbandonmentDispatch();

    expect(stats.skippedFailed).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
  });
});

// ─── Send outcomes ────────────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — send outcome: not configured", () => {
  it("unclaims and increments skippedNoConfig when outcome.configured is false", async () => {
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: false,
      delivered: false,
    });
    stageMinimalDispatch();
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null }); // unclaim

    const stats = await runCartAbandonmentDispatch();

    expect(stats.skippedNoConfig).toBe(1);
    expect(stats.skippedFailed).toBe(0);
    expect(stats.sent).toBe(0);
    expect(stats.sendgridConfigured).toBe(false);
    // Two update calls: claim + unclaim.
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(2);
  });
});

describe("runCartAbandonmentDispatch — send outcome: delivery failure", () => {
  it("unclaims and increments skippedFailed when outcome.delivered is false", async () => {
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: true,
      delivered: false,
      error: "550 user not found",
    });
    stageMinimalDispatch();
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null }); // unclaim

    const stats = await runCartAbandonmentDispatch();

    expect(stats.skippedFailed).toBe(1);
    expect(stats.skippedNoConfig).toBe(0);
    expect(stats.sent).toBe(0);
    expect(stats.sendgridConfigured).toBe(true);
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(2);
  });
});

// ─── Send throws (EmailConfigError pattern) ───────────────────────────────

describe("runCartAbandonmentDispatch — send throws", () => {
  it("aborts the loop, unclaims the current row, unclaimMany remaining, increments skippedNoConfig for all", async () => {
    // Three rows; the second send throws. First succeeds; second + third
    // should all be counted as skippedNoConfig.
    const rows = [
      makeCartRow({ id: "cart-1", customer_id: "cust-1", email: "p1@ex.com" }),
      makeCartRow({ id: "cart-2", customer_id: "cust-2", email: "p2@ex.com" }),
      makeCartRow({ id: "cart-3", customer_id: "cust-3", email: "p3@ex.com" }),
    ];

    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: rows.map((r) => ({ id: r.id })),
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: rows });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    // First send succeeds, second throws.
    sendCartAbandonmentEmailMock
      .mockResolvedValueOnce({ configured: true, delivered: true })
      .mockRejectedValueOnce(
        new Error("EmailConfigError: SENDGRID_API_KEY is required"),
      );

    // Unclaim for cart-2 (the one that threw).
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });
    // UnclaimMany for cart-3 (the remaining rows).
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    const stats = await runCartAbandonmentDispatch();

    // First row: sent; second + third: skippedNoConfig.
    expect(stats.sent).toBe(1);
    expect(stats.skippedNoConfig).toBe(2);
    expect(stats.skippedFailed).toBe(0);
    expect(stats.sendgridConfigured).toBe(false);
    // sendEmail called for cart-1 (success) and cart-2 (throw); NOT cart-3.
    expect(sendCartAbandonmentEmailMock).toHaveBeenCalledTimes(2);
  });

  it("sets sendgridConfigured=false and skips all when first send throws on a single-row batch", async () => {
    sendCartAbandonmentEmailMock.mockRejectedValueOnce(
      new Error("EmailConfigError: no API key"),
    );
    stageMinimalDispatch();
    // Unclaim for the one row.
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });
    // No more rows, so unclaimMany is a no-op (empty ids list).

    const stats = await runCartAbandonmentDispatch();

    expect(stats.sent).toBe(0);
    expect(stats.skippedNoConfig).toBe(1);
    expect(stats.sendgridConfigured).toBe(false);
  });
});

// ─── Mixed outcome across several rows ───────────────────────────────────

describe("runCartAbandonmentDispatch — mixed outcomes", () => {
  it("correctly tallies sent, skippedFailed, skippedOptOut, skippedNoConfig across different rows", async () => {
    const rows = [
      makeCartRow({ id: "c-1", customer_id: "cust-1", email: "a@ex.com" }), // → sent
      makeCartRow({ id: "c-2", customer_id: "cust-2", email: "b@ex.com" }), // → skippedFailed (delivery fail)
      makeCartRow({ id: "c-3", customer_id: "cust-3", email: "c@ex.com" }), // → skippedOptOut (opt-out)
      makeCartRow({ id: "c-4", customer_id: "cust-4", email: "d@ex.com" }), // → skippedNoConfig (not configured)
    ];

    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: rows.map((r) => ({ id: r.id })),
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: rows });
    stageSupabaseResponse("shop_customers", "select", {
      data: [
        // cust-3 has opted out.
        makePrefRow("cust-3", { emailAbandonedCart: false }),
      ],
    });

    // c-1: success
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: true,
      delivered: true,
    });
    // c-3 is opt-out → unclaim, no send call.
    // c-2: delivery failure
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: true,
      delivered: false,
      error: "bounce",
    });
    // c-4: not configured
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: false,
      delivered: false,
    });

    // Stage unclaims in loop order: c-2 (delivery fail), c-3 (opt-out), c-4 (not configured).
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null }); // unclaim c-2
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null }); // unclaim c-3
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null }); // unclaim c-4

    const stats = await runCartAbandonmentDispatch();

    expect(stats.scanned).toBe(4);
    expect(stats.sent).toBe(1);
    expect(stats.skippedFailed).toBe(1);
    expect(stats.skippedOptOut).toBe(1);
    expect(stats.skippedNoConfig).toBe(1);
    // sendgridConfigured flips to false once c-4 returns { configured: false }.
    expect(stats.sendgridConfigured).toBe(false);
  });
});

// ─── Logger integration ───────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — logger", () => {
  it("calls log.warn when sendEmail returns delivered:false", async () => {
    const warnMock = vi.fn();
    sendCartAbandonmentEmailMock.mockResolvedValueOnce({
      configured: true,
      delivered: false,
      error: "550 rejected",
    });
    stageMinimalDispatch();
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    await runCartAbandonmentDispatch({ log: { warn: warnMock } });

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "cart-1" }),
      "cart-abandonment send failed",
    );
  });

  it("calls log.warn when sendEmail throws", async () => {
    const warnMock = vi.fn();
    sendCartAbandonmentEmailMock.mockRejectedValueOnce(
      new Error("EmailConfigError: key missing"),
    );
    stageMinimalDispatch();
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    await runCartAbandonmentDispatch({ log: { warn: warnMock } });

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "cart-1" }),
      "cart-abandonment send threw — unclaiming batch",
    );
  });

  it("does not throw when log is omitted (opt-out path still works silently)", async () => {
    stageMinimalDispatch({
      prefRows: [makePrefRow("cust-1", { emailAbandonedCart: false })],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });

    // No log provided — should not throw.
    await expect(runCartAbandonmentDispatch()).resolves.toMatchObject({
      skippedOptOut: 1,
    });
  });

  it("calls log.warn when a single-row unclaim UPDATE fails, but does not throw", async () => {
    const warnMock = vi.fn();
    // Row is opt-out → triggers unclaim. Stage the unclaim to return an error.
    stageMinimalDispatch({
      prefRows: [makePrefRow("cust-1", { emailAbandonedCart: false })],
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      error: { message: "unclaim error" },
    });

    // Should resolve (not throw) even though unclaim failed.
    await expect(
      runCartAbandonmentDispatch({ log: { warn: warnMock } }),
    ).resolves.toMatchObject({ skippedOptOut: 1 });

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "cart-1" }),
      "cart-abandonment unclaim failed",
    );
  });
});

// ─── Claim payload ────────────────────────────────────────────────────────

describe("runCartAbandonmentDispatch — claim payload", () => {
  it("stamps reminded_at with the injected now timestamp", async () => {
    const pinned = new Date("2026-05-21T10:00:00.000Z");
    stageMinimalDispatch();

    await runCartAbandonmentDispatch({ now: pinned });

    const updates = getSupabaseWritePayloads("shop_abandoned_carts", "update");
    // First update is the claim.
    expect(updates[0]).toEqual({ reminded_at: pinned.toISOString() });
  });
});

// ─── Batch unclaim error path ─────────────────────────────────────────────
// Pre-existing CodeRabbit-generated test that was authored outside any
// describe block, breaking the parser for the whole file. Wrapped here
// without behavior change so the suite compiles.

describe("runCartAbandonmentDispatch — batch unclaim error path", () => {
  it("calls log.warn when the batch unclaimMany UPDATE fails, but does not throw", async () => {
    const warnMock = vi.fn();
    // Two-row batch; first send throws so unclaimMany is called for the second row.
    const rows = [
      makeCartRow({ id: "cart-A", customer_id: "cust-A", email: "a@ex.com" }),
      makeCartRow({ id: "cart-B", customer_id: "cust-B", email: "b@ex.com" }),
    ];
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: rows.map((r) => ({ id: r.id })),
    });
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: rows });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    sendCartAbandonmentEmailMock.mockRejectedValueOnce(
      new Error("EmailConfigError: key missing"),
    );

    // Unclaim cart-A (the thrower) — succeeds.
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });
    // UnclaimMany for cart-B — returns an error.
    stageSupabaseResponse("shop_abandoned_carts", "update", {
      error: { message: "batch unclaim error" },
    });

    const stats = await runCartAbandonmentDispatch({ log: { warn: warnMock } });

    // Still resolves with the correct stats envelope.
    expect(stats.skippedNoConfig).toBe(2);
    expect(stats.sendgridConfigured).toBe(false);

    // log.warn called for the batch unclaim failure.
    const batchWarnCall = warnMock.mock.calls.find(
      ([, msg]) => msg === "cart-abandonment unclaim batch failed",
    );
    expect(batchWarnCall).toBeDefined();
  });
});

// ─── Idempotency: zero claimed rows ──────────────────────────────────────

describe("runCartAbandonmentDispatch — zero claimed rows after race", () => {
  it("returns scanned=0 when the claim UPDATE returns no rows (parallel caller won)", async () => {
    stageSupabaseResponse("shop_abandoned_carts", "select", {
      data: [{ id: "cart-1" }],
    });
    // Claim returns nothing — parallel caller stamped first.
    stageSupabaseResponse("shop_abandoned_carts", "update", { data: null });
    // Prefs still fetched (empty userIds → skipped in code since claimed.length === 0... wait)
    // Actually when claimedRows is null, claimed = [], so we skip prefs fetch entirely.

    const stats = await runCartAbandonmentDispatch();

    expect(stats.scanned).toBe(0);
    expect(stats.sent).toBe(0);
    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
  });
});

// ─── Control Center feature flag gate ────────────────────────────────────

describe("runCartAbandonmentDispatch — feature flag gate", () => {
  it("returns zeroed stats immediately when cart_abandonment.dispatcher is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    const stats = await runCartAbandonmentDispatch();

    expect(stats).toEqual({
      scanned: 0,
      sent: 0,
      skippedNoConfig: 0,
      skippedFailed: 0,
      skippedOptOut: 0,
      sendgridConfigured: true,
    });
  });

  it("makes no DB calls when the feature flag is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    await runCartAbandonmentDispatch();

    expect(getSupabaseCallCount("shop_abandoned_carts", "select")).toBe(0);
    expect(getSupabaseCallCount("shop_abandoned_carts", "update")).toBe(0);
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("does not invoke sendCartAbandonmentEmail when the feature flag is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);

    await runCartAbandonmentDispatch();

    expect(sendCartAbandonmentEmailMock).not.toHaveBeenCalled();
  });

  it("calls log.warn when the feature flag is disabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(false);
    const warnMock = vi.fn();

    await runCartAbandonmentDispatch({ log: { warn: warnMock } });

    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "cart_abandonment_dispatch_skipped_feature_disabled",
      }),
      expect.stringContaining("feature flag disabled"),
    );
  });

  it("proceeds normally when the feature flag is enabled", async () => {
    isFeatureEnabledMock.mockResolvedValue(true);
    stageMinimalDispatch();

    const stats = await runCartAbandonmentDispatch();

    expect(stats.sent).toBe(1);
    expect(sendCartAbandonmentEmailMock).toHaveBeenCalledTimes(1);
  });
});
