// Tests for clearinghouse-credentials-api.ts.
//
// This PR migrated all `throw new Error(...)` calls to
// `throw new ApiError(res, data, { method, url })`.
//
// Coverage:
//   fetchClearinghouses   — GET /admin/clearinghouse-credentials
//   createClearinghouse   — POST  (sendJSON path)
//   updateClearinghouse   — PATCH (sendJSON path)
//   testClearinghouse     — POST  (sendJSON path)

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  fetchClearinghouses,
  createClearinghouse,
  updateClearinghouse,
  testClearinghouse,
  emptyClearinghouseBody,
} from "./clearinghouse-credentials-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function okResponse(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    url: "",
    json: async () => body,
  };
}

function errorResponse(
  status: number,
  statusText = "",
  body: unknown = {},
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    url: "",
    json: async () => body,
  };
}

const SAMPLE_BODY = emptyClearinghouseBody();
const SAMPLE_CH = {
  ...SAMPLE_BODY,
  id: "ch-1",
  lastPolledAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function setDocumentCookie(v: string) {
  (globalThis as unknown as { document?: unknown }).document = { cookie: v };
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

// ---------------------------------------------------------------------------
// fetchClearinghouses
// ---------------------------------------------------------------------------

describe("fetchClearinghouses", () => {
  test("GETs /resupply-api/admin/clearinghouse-credentials", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ clearinghouses: [SAMPLE_CH] }),
    );
    await fetchClearinghouses();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/clearinghouse-credentials");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue(okResponse({ clearinghouses: [] }));
    await fetchClearinghouses();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("returns the clearinghouses array on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ clearinghouses: [SAMPLE_CH] }),
    );
    const result = await fetchClearinghouses();
    expect(result.clearinghouses).toHaveLength(1);
    expect(result.clearinghouses[0].id).toBe("ch-1");
  });

  test("throws an ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await fetchClearinghouses().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    const err = await fetchClearinghouses().catch((e: unknown) => e);
    expect((err as ApiError).url).toContain(
      "/admin/clearinghouse-credentials",
    );
  });
});

// ---------------------------------------------------------------------------
// createClearinghouse
// ---------------------------------------------------------------------------

describe("createClearinghouse", () => {
  test("POSTs to /resupply-api/admin/clearinghouse-credentials", async () => {
    fetchMock.mockResolvedValue(okResponse({ clearinghouse: SAMPLE_CH }));
    await createClearinghouse(SAMPLE_BODY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/clearinghouse-credentials");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue(okResponse({ clearinghouse: SAMPLE_CH }));
    await createClearinghouse(SAMPLE_BODY);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/json");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, "Unprocessable", { error: "dup_slug" }),
    );
    const err = await createClearinghouse(SAMPLE_BODY).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// updateClearinghouse
// ---------------------------------------------------------------------------

describe("updateClearinghouse", () => {
  test("PATCHes to the correct URL", async () => {
    fetchMock.mockResolvedValue(okResponse({ clearinghouse: SAMPLE_CH }));
    await updateClearinghouse("ch-1", SAMPLE_BODY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/clearinghouse-credentials/ch-1",
    );
    expect(init.method).toBe("PATCH");
  });

  test("throws ApiError with method PATCH on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await updateClearinghouse("missing", SAMPLE_BODY).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("PATCH");
  });
});

// ---------------------------------------------------------------------------
// testClearinghouse
// ---------------------------------------------------------------------------

describe("testClearinghouse", () => {
  test("POSTs to the test URL", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ok: true, message: "Connected" }),
    );
    await testClearinghouse("ch-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/clearinghouse-credentials/ch-1/test",
    );
    expect(init.method).toBe("POST");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(503, "Service Unavailable"));
    const err = await testClearinghouse("ch-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });
});