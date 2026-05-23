// Tests for abandoned-carts-api.ts after this PR's simplification.
//
// PR change: csrfHeader() was removed from sendDueAbandonedCarts; the
// endpoint no longer sends an X-PF-CSRF header.
//
// Coverage:
//   listAdminAbandonedCarts — URL, Accept header, success, error shape
//   sendDueAbandonedCarts   — URL, method, Accept header, no X-PF-CSRF,
//                             success response, error shape

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listAdminAbandonedCarts,
  sendDueAbandonedCarts,
} from "./abandoned-carts-api";

// ─── Setup / teardown ───────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ─── listAdminAbandonedCarts ─────────────────────────────────────────────────

describe("listAdminAbandonedCarts — request shape", () => {
  it("fetches /resupply-api/admin/shop/abandoned-carts", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [] }));

    await listAdminAbandonedCarts();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/abandoned-carts");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [] }));

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("does not send an X-PF-CSRF header (csrf removed in this PR)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [] }));

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });

  it("uses a GET request (no method override)", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [] }));

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // fetch defaults to GET when method is omitted
    expect(init.method).toBeUndefined();
  });
});

describe("listAdminAbandonedCarts — response handling", () => {
  it("returns the rows array on success", async () => {
    const rows = [
      {
        id: "cart-1",
        customerId: "cust-1",
        emailRedacted: "p***@example.com",
        itemCount: 2,
        subtotalCents: 4999,
        currency: "usd",
        updatedAt: "2026-01-01T00:00:00Z",
        remindedAt: null,
        recoveredAt: null,
        clearedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows }));

    const result = await listAdminAbandonedCarts();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe("cart-1");
  });

  it("returns an empty rows array when no abandoned carts exist", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [] }));

    const result = await listAdminAbandonedCarts();
    expect(result.rows).toHaveLength(0);
  });

  it("preserves all cart row fields in the returned data", async () => {
    const row = {
      id: "cart-abc",
      customerId: null,
      emailRedacted: "a***@example.com",
      itemCount: 5,
      subtotalCents: 12345,
      currency: "usd",
      updatedAt: "2026-02-01T12:00:00Z",
      remindedAt: "2026-02-02T08:00:00Z",
      recoveredAt: null,
      clearedAt: null,
      createdAt: "2026-01-31T00:00:00Z",
    };
    fetchMock.mockResolvedValueOnce(makeResponse(200, { rows: [row] }));

    const result = await listAdminAbandonedCarts();
    expect(result.rows[0]).toEqual(row);
  });

  it("throws on a 403 forbidden response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(403, { error: "forbidden" }));
    await expect(listAdminAbandonedCarts()).rejects.toThrow("403");
  });

  it("throws with 'Failed to load abandoned carts' context on error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      "Failed to load abandoned carts",
    );
  });

  it("includes the HTTP status in the error message", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(404, {}));
    await expect(listAdminAbandonedCarts()).rejects.toThrow("(404)");
  });
});

// ─── sendDueAbandonedCarts ───────────────────────────────────────────────────

describe("sendDueAbandonedCarts — request shape", () => {
  it("POSTs to /resupply-api/admin/shop/abandoned-carts/send-due", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: true,
      }),
    );

    await sendDueAbandonedCarts();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/shop/abandoned-carts/send-due",
    );
    expect(init.method).toBe("POST");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: false,
      }),
    );

    await sendDueAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("does NOT send an X-PF-CSRF header (csrf removed in this PR)", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: true,
      }),
    );

    await sendDueAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // This is the key regression guard: the PR removed csrfHeader() from this
    // call. Any re-introduction of X-PF-CSRF would break this assertion.
    expect("X-PF-CSRF" in headers).toBe(false);
  });
});

describe("sendDueAbandonedCarts — response handling", () => {
  it("returns the send-due stats on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 10,
        sent: 7,
        skippedNoConfig: 1,
        skippedFailed: 2,
        sendgridConfigured: true,
      }),
    );

    const result = await sendDueAbandonedCarts();
    expect(result.scanned).toBe(10);
    expect(result.sent).toBe(7);
    expect(result.skippedNoConfig).toBe(1);
    expect(result.skippedFailed).toBe(2);
    expect(result.sendgridConfigured).toBe(true);
  });

  it("returns sendgridConfigured:false when SendGrid is not configured", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 5,
        sent: 0,
        skippedNoConfig: 5,
        skippedFailed: 0,
        sendgridConfigured: false,
      }),
    );

    const result = await sendDueAbandonedCarts();
    expect(result.sendgridConfigured).toBe(false);
    expect(result.skippedNoConfig).toBe(5);
    expect(result.sent).toBe(0);
  });

  it("returns zero counts when no carts are due", async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: true,
      }),
    );

    const result = await sendDueAbandonedCarts();
    expect(result.scanned).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("throws on a 503 response", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(503, {}));
    await expect(sendDueAbandonedCarts()).rejects.toThrow("503");
  });

  it("throws with 'Send-due failed' context on error", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(500, {}));
    await expect(sendDueAbandonedCarts()).rejects.toThrow("Send-due failed");
  });

  it("includes the HTTP status in the error message", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(422, {}));
    await expect(sendDueAbandonedCarts()).rejects.toThrow("(422)");
  });
});
