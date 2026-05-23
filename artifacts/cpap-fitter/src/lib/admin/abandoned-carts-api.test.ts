// Tests for abandoned-carts-api.ts — fetch wrappers for
// /resupply-api/admin/shop/abandoned-carts
//
// Coverage:
//   listAdminAbandonedCarts  — GET, Accept header, error messages
//   sendDueAbandonedCarts    — POST, Accept header, error messages

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listAdminAbandonedCarts,
  sendDueAbandonedCarts,
} from "./abandoned-carts-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// listAdminAbandonedCarts
// ---------------------------------------------------------------------------

describe("listAdminAbandonedCarts", () => {
  test("requests GET /resupply-api/admin/shop/abandoned-carts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/abandoned-carts");
  });

  test("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("does not send credentials: include (cookie auth is implicit)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // credentials is not explicitly set in this wrapper
    expect(init.credentials).toBeUndefined();
  });

  test("returns the parsed rows array on success", async () => {
    const row = {
      id: "cart-1",
      customerId: "cust-abc",
      emailRedacted: "j***@example.com",
      itemCount: 3,
      subtotalCents: 4500,
      currency: "USD",
      updatedAt: "2025-01-10T12:00:00Z",
      remindedAt: null,
      recoveredAt: null,
      clearedAt: null,
      createdAt: "2025-01-10T10:00:00Z",
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [row] }),
    });

    const result = await listAdminAbandonedCarts();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe("cart-1");
    expect(result.rows[0]!.itemCount).toBe(3);
    expect(result.rows[0]!.subtotalCents).toBe(4500);
    expect(result.rows[0]!.currency).toBe("USD");
  });

  test("returns empty rows array when no abandoned carts exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    const result = await listAdminAbandonedCarts();
    expect(result.rows).toEqual([]);
  });

  test("throws with status in message on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      "Failed to load abandoned carts (403)",
    );
  });

  test("throws with status 500 message on server error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      "Failed to load abandoned carts (500)",
    );
  });

  test("throws with status 401 message when unauthenticated", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => ({}),
    });

    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      "Failed to load abandoned carts (401)",
    );
  });

  test("calls fetch exactly once per invocation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("handles rows with optional nullable fields", async () => {
    const rowWithNulls = {
      id: "cart-null",
      customerId: null,
      emailRedacted: null,
      itemCount: 1,
      subtotalCents: 1999,
      currency: "USD",
      updatedAt: "2025-02-01T09:00:00Z",
      remindedAt: "2025-02-01T10:00:00Z",
      recoveredAt: null,
      clearedAt: null,
      createdAt: "2025-02-01T08:00:00Z",
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [rowWithNulls] }),
    });

    const result = await listAdminAbandonedCarts();
    expect(result.rows[0]!.customerId).toBeNull();
    expect(result.rows[0]!.emailRedacted).toBeNull();
    expect(result.rows[0]!.remindedAt).toBe("2025-02-01T10:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// sendDueAbandonedCarts
// ---------------------------------------------------------------------------

describe("sendDueAbandonedCarts", () => {
  test("requests POST /resupply-api/admin/shop/abandoned-carts/send-due", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 10,
        sent: 5,
        skippedNoConfig: 2,
        skippedFailed: 1,
        sendgridConfigured: true,
      }),
    });

    await sendDueAbandonedCarts();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/abandoned-carts/send-due");
    expect(init.method).toBe("POST");
  });

  test("sends Accept: application/json header", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: false,
      }),
    });

    await sendDueAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("returns SendDueResponse with correct fields on success", async () => {
    const payload = {
      scanned: 20,
      sent: 8,
      skippedNoConfig: 3,
      skippedFailed: 2,
      sendgridConfigured: true,
    };

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await sendDueAbandonedCarts();
    expect(result.scanned).toBe(20);
    expect(result.sent).toBe(8);
    expect(result.skippedNoConfig).toBe(3);
    expect(result.skippedFailed).toBe(2);
    expect(result.sendgridConfigured).toBe(true);
  });

  test("returns sendgridConfigured: false when SendGrid is not configured", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 5,
        sent: 0,
        skippedNoConfig: 5,
        skippedFailed: 0,
        sendgridConfigured: false,
      }),
    });

    const result = await sendDueAbandonedCarts();
    expect(result.sendgridConfigured).toBe(false);
    expect(result.sent).toBe(0);
    expect(result.skippedNoConfig).toBe(5);
  });

  test("throws with status in message on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({}),
    });

    await expect(sendDueAbandonedCarts()).rejects.toThrow(
      "Send-due failed (503)",
    );
  });

  test("throws with status 403 message when unauthorized", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(sendDueAbandonedCarts()).rejects.toThrow(
      "Send-due failed (403)",
    );
  });

  test("throws with status 500 message on server error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    });

    await expect(sendDueAbandonedCarts()).rejects.toThrow(
      "Send-due failed (500)",
    );
  });

  test("calls fetch exactly once per invocation", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: true,
      }),
    });

    await sendDueAbandonedCarts();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Error message format — boundary test for different status codes
// ---------------------------------------------------------------------------

describe("abandoned-carts-api — error message format", () => {
  test("listAdminAbandonedCarts error includes the exact status code in parentheses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      json: async () => ({}),
    });

    await expect(listAdminAbandonedCarts()).rejects.toThrow(/\(429\)/);
  });

  test("sendDueAbandonedCarts error includes the exact status code in parentheses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      json: async () => ({}),
    });

    await expect(sendDueAbandonedCarts()).rejects.toThrow(/\(422\)/);
  });

  test("sendDueAbandonedCarts error message starts with 'Send-due failed'", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({}),
    });

    await expect(sendDueAbandonedCarts()).rejects.toThrow(/^Send-due failed/);
  });

  test("listAdminAbandonedCarts error message starts with 'Failed to load abandoned carts'", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({}),
    });

    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      /^Failed to load abandoned carts/,
    );
  });
});