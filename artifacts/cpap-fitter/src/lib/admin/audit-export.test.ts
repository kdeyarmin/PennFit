// Tests for audit-export.ts — downloadAuditExport().
//
// This PR changed the non-OK error path from
//   throw new Error(`Audit export failed (${res.status})...`)
// to
//   throw new ApiError(res, detail || null, { method: "GET", url })
//
// The success path involves DOM APIs (URL.createObjectURL, document.createElement)
// so we use the jsdom environment for this file.
//
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import { downloadAuditExport } from "./audit-export";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function makeOkResponse(
  csvText: string,
  filename = "audit-2026-01-01.csv",
): Partial<Response> {
  const headers = new Headers({
    "content-disposition": `attachment; filename="${filename}"`,
    "content-type": "text/csv",
  });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers,
    url: "",
    text: async () => csvText,
    blob: async () => new Blob([csvText], { type: "text/csv" }),
  };
}

function makeErrorResponse(
  status: number,
  statusText: string,
  body = "",
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    url: "",
    text: async () => body,
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  // Stub DOM methods used by downloadAuditExport
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Error path — ApiError thrown on non-OK response
// ---------------------------------------------------------------------------

describe("downloadAuditExport — error handling", () => {
  it("throws an ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(403, "Forbidden"));
    const err = await downloadAuditExport({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("throws ApiError with status 500", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500, "Internal Server Error", "Server error"));
    const err = await downloadAuditExport({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("attaches the response body text as data on the ApiError", async () => {
    fetchMock.mockResolvedValue(
      makeErrorResponse(422, "Unprocessable Entity", "invalid_filter"),
    );
    const err = await downloadAuditExport({
      action: "bad",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).data).toBe("invalid_filter");
  });

  it("ApiError.data is null when the error body is empty", async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(401, "Unauthorized", ""));
    const err = await downloadAuditExport({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).data).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// URL construction — query string built from filters
// ---------------------------------------------------------------------------

describe("downloadAuditExport — URL construction", () => {
  it("hits /resupply-api/audit/export.csv with no query when no filters", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\nrow1\n"));
    await downloadAuditExport({});
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/audit/export.csv");
  });

  it("appends action filter to the query string", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\nrow1\n"));
    await downloadAuditExport({ action: "order.approve" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("action=order.approve");
  });

  it("appends targetTable filter", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\nrow1\n"));
    await downloadAuditExport({ targetTable: "orders" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("targetTable=orders");
  });

  it("appends since filter", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\n"));
    await downloadAuditExport({ since: "2026-01-01" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("since=2026-01-01");
  });

  it("combines multiple filters in the query string", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\n"));
    await downloadAuditExport({
      action: "order.approve",
      targetTable: "orders",
    });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("action=order.approve");
    expect(url).toContain("targetTable=orders");
  });

  it("sends Accept: text/csv", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("header\n"));
    await downloadAuditExport({});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/csv");
  });
});

// ---------------------------------------------------------------------------
// Success path — return value
// ---------------------------------------------------------------------------

describe("downloadAuditExport — success path", () => {
  it("parses the filename from Content-Disposition", async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse("date,action\n2026-01-01,login\n", "audit-2026-01.csv"),
    );
    const { filename } = await downloadAuditExport({});
    expect(filename).toBe("audit-2026-01.csv");
  });

  it("falls back to a generated filename when Content-Disposition is absent", async () => {
    const response = makeOkResponse("header\nrow\n");
    // Remove the content-disposition header
    const headers = new Headers();
    headers.set("content-type", "text/csv");
    (response as Record<string, unknown>).headers = headers;
    fetchMock.mockResolvedValue(response);
    const { filename } = await downloadAuditExport({});
    expect(filename).toMatch(/^audit-export-\d+\.csv$/);
  });

  it("returns rowCountApprox equal to number of data rows", async () => {
    // 1 header + 3 data rows = 4 lines, rowCountApprox = 3
    fetchMock.mockResolvedValue(
      makeOkResponse("date,action\nrow1\nrow2\nrow3\n"),
    );
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(3);
  });

  it("returns rowCountApprox 0 for a header-only CSV", async () => {
    fetchMock.mockResolvedValue(makeOkResponse("date,action\n"));
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rowCountApprox — empty-line filtering (PR fix)
// ---------------------------------------------------------------------------
//
// The PR changed the row-count calculation from:
//   text.split("\n").length - 1
// to:
//   text.split("\n").filter(line => line.length > 0).length - 1
//
// This matters because the server emits a trailing newline at the end of
// every CSV. The old code over-counted by 1 for every export, and reported
// 1 instead of 0 for a header-only export.

describe("downloadAuditExport — rowCountApprox empty-line filtering", () => {
  it("trailing newline does not inflate the count (3 data rows stays 3)", async () => {
    // "header\nrow1\nrow2\nrow3\n" → split gives 5 elements (last is "")
    // old code: 5 - 1 = 4 (WRONG), new code: 4 non-empty - 1 = 3 (CORRECT)
    fetchMock.mockResolvedValue(
      makeOkResponse("date,action\nrow1\nrow2\nrow3\n"),
    );
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(3);
  });

  it("header-only CSV with trailing newline returns 0 (not 1)", async () => {
    // "date,action\n" → split gives ["date,action", ""]
    // old code: 2 - 1 = 1 (WRONG — looks like 1 row), new code: 1 - 1 = 0 (CORRECT)
    fetchMock.mockResolvedValue(makeOkResponse("date,action\n"));
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(0);
  });

  it("multiple trailing newlines still return the correct count", async () => {
    // "header\nrow1\n\n" → split gives ["header", "row1", "", ""]
    // old code: 4 - 1 = 3 (WRONG), new code: 2 non-empty - 1 = 1 (CORRECT)
    fetchMock.mockResolvedValue(makeOkResponse("date,action\nrow1\n\n"));
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(1);
  });

  it("completely empty CSV body returns 0", async () => {
    // "" → split gives [""], filter gives [], length 0 - 1 = -1 → max(0, -1) = 0
    fetchMock.mockResolvedValue(makeOkResponse(""));
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(0);
  });

  it("CSV with blank lines interspersed does not count blank lines as rows", async () => {
    // Some export tools may emit blank separator lines; they must be ignored.
    // "header\n\nrow1\n\nrow2\n" → non-empty: ["header", "row1", "row2"] → 3 - 1 = 2
    fetchMock.mockResolvedValue(
      makeOkResponse("date,action\n\nrow1\n\nrow2\n"),
    );
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(2);
  });

  it("single data row with trailing newline returns 1", async () => {
    // "header\nrow1\n" → non-empty: ["header", "row1"] → 2 - 1 = 1
    fetchMock.mockResolvedValue(makeOkResponse("date,action\nrow1\n"));
    const { rowCountApprox } = await downloadAuditExport({});
    expect(rowCountApprox).toBe(1);
  });
});