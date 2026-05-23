// Tests for abandoned-carts-api.ts.
//
// This PR added csrfHeader() to the sendDueAbandonedCarts POST call.
//
// Coverage:
//   listAdminAbandonedCarts — URL, Accept header, success, error
//   sendDueAbandonedCarts   — URL, method, Accept header, X-PF-CSRF header,
//                             success, error

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listAdminAbandonedCarts,
  sendDueAbandonedCarts,
} from "./abandoned-carts-api";

// ─── Setup / teardown ───────────────────────────────────────────────────────

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function setDocumentCookie(cookie: string | null) {
  if (cookie === null) {
    delete (globalThis as unknown as { document?: unknown }).document;
  } else {
    (globalThis as unknown as { document?: unknown }).document = { cookie };
  }
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  setDocumentCookie("");
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete (globalThis as unknown as { document?: unknown }).document;
  vi.restoreAllMocks();
});

// ─── listAdminAbandonedCarts ──────────────────────────────────────────────────

describe("listAdminAbandonedCarts", () => {
  it("fetches /resupply-api/admin/shop/abandoned-carts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/abandoned-carts");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
    });

    await listAdminAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("returns the rows array", async () => {
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
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rows }),
    });

    const result = await listAdminAbandonedCarts();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.id).toBe("cart-1");
  });

  it("throws on non-OK status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(listAdminAbandonedCarts()).rejects.toThrow("403");
  });

  it("error message includes the operation context", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(listAdminAbandonedCarts()).rejects.toThrow(
      "Failed to load abandoned carts",
    );
  });
});

// ─── sendDueAbandonedCarts ────────────────────────────────────────────────────

describe("sendDueAbandonedCarts — request shape", () => {
  it("POSTs to /resupply-api/admin/shop/abandoned-carts/send-due", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 5,
        sent: 3,
        skippedNoConfig: 0,
        skippedFailed: 0,
        sendgridConfigured: true,
      }),
    });

    await sendDueAbandonedCarts();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/shop/abandoned-carts/send-due",
    );
    expect(init.method).toBe("POST");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 0,
        sent: 0,
        skippedNoConfig: 1,
        skippedFailed: 0,
        sendgridConfigured: false,
      }),
    });

    await sendDueAbandonedCarts();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("includes X-PF-CSRF header when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=csrf-abc");
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

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-PF-CSRF"]).toBe(
      "csrf-abc",
    );
  });

  it("omits X-PF-CSRF when pf_csrf cookie is absent", async () => {
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

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect("X-PF-CSRF" in (init.headers as Record<string, string>)).toBe(false);
  });
});

describe("sendDueAbandonedCarts — response handling", () => {
  it("returns the send-due stats on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scanned: 10,
        sent: 7,
        skippedNoConfig: 1,
        skippedFailed: 2,
        sendgridConfigured: true,
      }),
    });

    const result = await sendDueAbandonedCarts();
    expect(result.scanned).toBe(10);
    expect(result.sent).toBe(7);
    expect(result.skippedNoConfig).toBe(1);
    expect(result.skippedFailed).toBe(2);
    expect(result.sendgridConfigured).toBe(true);
  });

  it("throws on non-OK status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(sendDueAbandonedCarts()).rejects.toThrow("503");
  });

  it("error message contains 'Send-due failed'", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(sendDueAbandonedCarts()).rejects.toThrow("Send-due failed");
  });
});