// Tests for lib/admin/analytics-api.ts
//
// Per-operator (CSR) productivity is derived from the retired `audit_log`
// table, so the route short-circuits to a degraded response (CLAUDE.md
// hard rule: no new `audit_log` readers). CsrProductivityResponse models
// that with an optional `unavailable?` flag the UI surfaces as a "no
// longer tracked" notice.
//
// Coverage:
//   1. CsrProductivityResponse type carries the optional `unavailable` flag.
//   2. CsrProductivityResponse carries the required fields.
//   3. fetchCsrProductivity() calls the correct URL.
//   4. fetchCsrProductivity() propagates server errors correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchCsrProductivity } from "./analytics-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "analytics-api.ts"), "utf8");

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
// Type shape — CsrProductivityResponse no longer has `unavailable`
// ---------------------------------------------------------------------------

describe("analytics-api — CsrProductivityResponse type shape", () => {
  it("CsrProductivityResponse interface declares the optional `unavailable` flag", () => {
    const ifaceStart = SRC.indexOf("interface CsrProductivityResponse {");
    expect(ifaceStart).toBeGreaterThan(-1);
    // Closing brace sits at column 0 (`\n}`).
    const ifaceEnd = SRC.indexOf("\n}", ifaceStart);
    const ifaceBody = SRC.slice(ifaceStart, ifaceEnd);
    expect(ifaceBody).toContain("unavailable?: boolean");
  });

  it("CsrProductivityResponse interface declares the required fields", () => {
    const ifaceStart = SRC.indexOf("interface CsrProductivityResponse {");
    const ifaceEnd = SRC.indexOf("\n}", ifaceStart);
    const ifaceBody = SRC.slice(ifaceStart, ifaceEnd);
    expect(ifaceBody).toContain("windowDays");
    expect(ifaceBody).toContain("rows");
    expect(ifaceBody).toContain("totalActions");
  });
});

// ---------------------------------------------------------------------------
// fetchCsrProductivity() — network behaviour
// ---------------------------------------------------------------------------

describe("fetchCsrProductivity", () => {
  it("calls the correct URL with the days parameter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        windowDays: 30,
        rows: [],
        totalActions: 0,
      }),
    });

    await fetchCsrProductivity(30);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/analytics/csr-productivity?days=30");
  });

  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ windowDays: 7, rows: [], totalActions: 0 }),
    });

    await fetchCsrProductivity(7);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("returns the parsed JSON body on success", async () => {
    const payload = {
      windowDays: 14,
      rows: [
        {
          operator: "csr@example.com",
          total: 42,
          byAction: { "order.approve": 42 },
          lastActiveDate: "2026-05-20",
        },
      ],
      totalActions: 42,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchCsrProductivity(14);
    expect(result).toEqual(payload);
  });

  it("throws on a non-ok response, using the message field from the JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({ message: "db connection lost" }),
    });

    await expect(fetchCsrProductivity(7)).rejects.toThrow("db connection lost");
  });

  it("falls back to status+statusText when the error body is unparseable", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });

    await expect(fetchCsrProductivity(7)).rejects.toThrow(
      "503 Service Unavailable",
    );
  });
});