// Tests for backorders-api.ts — fetch wrappers for /admin/shop/backorders
// and /admin/shop/sku-substitutes.
//
// Coverage:
//   jsonFetch shared behaviour  — URL, credentials, Accept header, error handling
//   listBackorders              — GET /admin/shop/backorders
//   markBackorder               — POST /admin/shop/backorders
//   clearBackorder              — POST /admin/shop/backorders/:id/clear
//   listSubstitutes             — GET /admin/shop/sku-substitutes (with/without filter)
//   createSubstitute            — POST /admin/shop/sku-substitutes
//   patchSubstitute             — PATCH /admin/shop/sku-substitutes/:id
//   deleteSubstitute            — DELETE /admin/shop/sku-substitutes/:id

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  listBackorders,
  markBackorder,
  clearBackorder,
  listSubstitutes,
  createSubstitute,
  patchSubstitute,
  deleteSubstitute,
} from "./backorders-api";

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
// jsonFetch shared behaviour (via listBackorders)
// ---------------------------------------------------------------------------

describe("jsonFetch shared behaviour (via listBackorders)", () => {
  test("requests /resupply-api prefix on the URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [] }),
    });

    await listBackorders();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/backorders");
  });

  test("sends credentials: include", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [] }),
    });

    await listBackorders();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [] }),
    });

    await listBackorders();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws Error on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({}),
    });

    await expect(listBackorders()).rejects.toThrow("403");
  });

  test("throws using message field from error JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "sku already on backorder" }),
    });

    await expect(listBackorders()).rejects.toThrow("sku already on backorder");
  });

  test("throws using error field when message is absent", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "missing_sku" }),
    });

    await expect(listBackorders()).rejects.toThrow("missing_sku");
  });

  test("falls back to status when JSON is unparseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(listBackorders()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// listBackorders
// ---------------------------------------------------------------------------

describe("listBackorders", () => {
  const SAMPLE_BACKORDER = {
    id: "bo-1",
    sku: "E0601-MASK",
    markedAt: "2025-01-01T00:00:00Z",
    clearedAt: null,
    notes: "Vendor delay",
    markedByUserId: "admin-1",
    createdAt: "2025-01-01T00:00:00Z",
  };

  test("requests /resupply-api/admin/shop/backorders", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [] }),
    });

    await listBackorders();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/backorders");
  });

  test("returns the parsed backorders array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [SAMPLE_BACKORDER] }),
    });

    const result = await listBackorders();
    expect(result.backorders).toHaveLength(1);
    expect(result.backorders[0]!.sku).toBe("E0601-MASK");
    expect(result.backorders[0]!.clearedAt).toBeNull();
  });

  test("returns empty backorders array when none exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ backorders: [] }),
    });

    const result = await listBackorders();
    expect(result.backorders).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "ISE", json: async () => ({}) });
    await expect(listBackorders()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// markBackorder
// ---------------------------------------------------------------------------

describe("markBackorder", () => {
  test("posts to /resupply-api/admin/shop/backorders", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "bo-new" }),
    });

    await markBackorder({ sku: "E0601" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/backorders");
    expect(init.method).toBe("POST");
  });

  test("serialises the sku and optional notes in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "bo-new" }),
    });

    await markBackorder({ sku: "A7030", notes: "Supplier shortage" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      sku: "A7030",
      notes: "Supplier shortage",
    });
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "bo-new" }),
    });

    await markBackorder({ sku: "E0601" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("returns the new backorder id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "bo-created-999" }),
    });

    const result = await markBackorder({ sku: "E0601" });
    expect(result.id).toBe("bo-created-999");
  });

  test("throws on non-OK response (e.g. already on backorder)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: "sku already on backorder" }),
    });
    await expect(markBackorder({ sku: "E0601" })).rejects.toThrow(
      "sku already on backorder",
    );
  });
});

// ---------------------------------------------------------------------------
// clearBackorder
// ---------------------------------------------------------------------------

describe("clearBackorder", () => {
  test("posts to /resupply-api/admin/shop/backorders/:id/clear", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await clearBackorder("bo-123");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/backorders/bo-123/clear");
    expect(init.method).toBe("POST");
  });

  test("sends an empty body when no notes are provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await clearBackorder("bo-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  test("includes notes in the body when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await clearBackorder("bo-1", "Back in stock");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ notes: "Back in stock" });
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await clearBackorder("bo-1");
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
    await expect(clearBackorder("bo-ghost")).rejects.toThrow("404");
  });
});

// ---------------------------------------------------------------------------
// listSubstitutes
// ---------------------------------------------------------------------------

const SAMPLE_SUB = {
  id: "sub-1",
  primarySku: "E0601",
  alternativeSku: "E0601-REMED",
  priority: 1,
  active: true,
  notes: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

describe("listSubstitutes", () => {
  test("requests /resupply-api/admin/shop/sku-substitutes without filter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ substitutes: [] }),
    });

    await listSubstitutes();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/sku-substitutes");
  });

  test("appends ?primary_sku= filter when primarySku is provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ substitutes: [] }),
    });

    await listSubstitutes("E0601");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/shop/sku-substitutes?primary_sku=E0601",
    );
  });

  test("URL-encodes the primarySku filter value", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ substitutes: [] }),
    });

    await listSubstitutes("SKU WITH SPACES");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("SKU+WITH+SPACES");
  });

  test("returns the parsed substitutes array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ substitutes: [SAMPLE_SUB] }),
    });

    const result = await listSubstitutes();
    expect(result.substitutes).toHaveLength(1);
    expect(result.substitutes[0]!.primarySku).toBe("E0601");
    expect(result.substitutes[0]!.active).toBe(true);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "ISE", json: async () => ({}) });
    await expect(listSubstitutes()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// createSubstitute
// ---------------------------------------------------------------------------

describe("createSubstitute", () => {
  const CREATE_INPUT = {
    primarySku: "E0601",
    alternativeSku: "E0601-REMED",
    priority: 1,
  };

  test("posts to /resupply-api/admin/shop/sku-substitutes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "sub-new" }),
    });

    await createSubstitute(CREATE_INPUT);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/sku-substitutes");
    expect(init.method).toBe("POST");
  });

  test("serialises the body correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "sub-new" }),
    });

    await createSubstitute(CREATE_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(CREATE_INPUT);
  });

  test("includes optional notes when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "sub-new" }),
    });

    await createSubstitute({ ...CREATE_INPUT, notes: "Use when primary is OOS" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      notes: "Use when primary is OOS",
    });
  });

  test("returns the new substitute id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "sub-created-abc" }),
    });

    const result = await createSubstitute(CREATE_INPUT);
    expect(result.id).toBe("sub-created-abc");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, statusText: "Conflict", json: async () => ({}) });
    await expect(createSubstitute(CREATE_INPUT)).rejects.toThrow("409");
  });
});

// ---------------------------------------------------------------------------
// patchSubstitute
// ---------------------------------------------------------------------------

describe("patchSubstitute", () => {
  test("sends PATCH to /resupply-api/admin/shop/sku-substitutes/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await patchSubstitute("sub-1", { active: false });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/shop/sku-substitutes/sub-1");
    expect(init.method).toBe("PATCH");
  });

  test("serialises the patch body correctly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const body = { priority: 2, active: true, notes: "Updated" };
    await patchSubstitute("sub-1", body);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  test("can clear notes by sending null", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await patchSubstitute("sub-1", { notes: null });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ notes: null });
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await patchSubstitute("sub-1", { active: false });
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
    await expect(patchSubstitute("no-such-sub", {})).rejects.toThrow("404");
  });
});

// ---------------------------------------------------------------------------
// deleteSubstitute
// ---------------------------------------------------------------------------

describe("deleteSubstitute", () => {
  test("sends DELETE to /resupply-api/admin/shop/sku-substitutes/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await deleteSubstitute("sub-to-delete");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/shop/sku-substitutes/sub-to-delete",
    );
    expect(init.method).toBe("DELETE");
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await deleteSubstitute("sub-1");
    expect(result).toEqual({ ok: true });
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
    await expect(deleteSubstitute("sub-ghost")).rejects.toThrow("404");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await deleteSubstitute("sub-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});