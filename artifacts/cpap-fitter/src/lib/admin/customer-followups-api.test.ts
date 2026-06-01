// Tests for customer-followups-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
// Special case: 404 responses throw AdminCustomerFollowupsNotFoundError,
// NOT ApiError (that's unchanged).
//
// Coverage:
//   listAdminCustomerFollowups     — GET  /shop/customers/:id/followups
//   createAdminCustomerFollowup    — POST /shop/customers/:id/followups
//   completeAdminCustomerFollowup  — PATCH /shop/customers/:id/followups/:fid/complete

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  listAdminCustomerFollowups,
  createAdminCustomerFollowup,
  completeAdminCustomerFollowup,
  AdminCustomerFollowupsNotFoundError,
} from "./customer-followups-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function okResponse(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    url: "/resupply-api/admin/shop/customers/user-1/followups",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(
  status: number,
  statusText = "",
  body = "",
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    url: `/resupply-api/admin/shop/customers/user-1/followups`,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        throw new SyntaxError("not json");
      }
    },
    text: async () => body,
  };
}

const FOLLOWUP = {
  id: "fu-1",
  body: "Call back about equipment",
  dueAt: "2026-02-01T00:00:00Z",
  completedAt: null,
  completedByEmail: null,
  createdByEmail: "csr@example.com",
  createdAt: "2026-01-01T00:00:00Z",
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
// listAdminCustomerFollowups
// ---------------------------------------------------------------------------

describe("listAdminCustomerFollowups", () => {
  test("GETs /resupply-api/admin/shop/customers/:id/followups", async () => {
    fetchMock.mockResolvedValue(okResponse({ followups: [] }));
    await listAdminCustomerFollowups("user-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/shop/customers/user-1/followups");
  });

  test("appends ?include=completed when includeCompleted is true", async () => {
    fetchMock.mockResolvedValue(okResponse({ followups: [] }));
    await listAdminCustomerFollowups("user-1", { includeCompleted: true });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("include=completed");
  });

  test("does not append query when includeCompleted is false", async () => {
    fetchMock.mockResolvedValue(okResponse({ followups: [] }));
    await listAdminCustomerFollowups("user-1", { includeCompleted: false });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("include=completed");
  });

  test("returns followups array on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ followups: [FOLLOWUP] }));
    const result = await listAdminCustomerFollowups("user-1");
    expect(result.followups).toHaveLength(1);
    expect(result.followups[0].body).toBe("Call back about equipment");
  });

  test("throws AdminCustomerFollowupsNotFoundError on 404", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await listAdminCustomerFollowups("user-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdminCustomerFollowupsNotFoundError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  test("throws ApiError (not NotFoundError) on non-404 non-OK status", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await listAdminCustomerFollowups("user-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("throws ApiError on 500", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "Internal Server Error"));
    const err = await listAdminCustomerFollowups("user-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// createAdminCustomerFollowup
// ---------------------------------------------------------------------------

describe("createAdminCustomerFollowup", () => {
  const DUE_AT = new Date("2026-03-01T12:00:00Z");

  test("POSTs to /admin/shop/customers/:id/followups", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        id: "fu-new",
        dueAt: DUE_AT.toISOString(),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createAdminCustomerFollowup("user-1", "Check in", DUE_AT);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/admin/shop/customers/user-1/followups");
    expect(init.method).toBe("POST");
  });

  test("serialises body and dueAt in the request body", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        id: "fu-new",
        dueAt: DUE_AT.toISOString(),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    await createAdminCustomerFollowup("user-1", "Check in", DUE_AT);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.body).toBe("Check in");
    expect(parsed.dueAt).toBe(DUE_AT.toISOString());
  });

  test("returns id and dueAt on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        id: "fu-abc",
        dueAt: DUE_AT.toISOString(),
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );
    const result = await createAdminCustomerFollowup(
      "user-1",
      "Check in",
      DUE_AT,
    );
    expect(result.id).toBe("fu-abc");
  });

  test("throws AdminCustomerFollowupsNotFoundError on 404", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await createAdminCustomerFollowup(
      "missing-user",
      "note",
      DUE_AT,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminCustomerFollowupsNotFoundError);
  });

  test("throws ApiError on non-404 non-OK status", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(422, "Unprocessable Entity", "validation failed"),
    );
    const err = await createAdminCustomerFollowup("user-1", "x", DUE_AT).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// completeAdminCustomerFollowup
// ---------------------------------------------------------------------------

describe("completeAdminCustomerFollowup", () => {
  test("PATCHes to /admin/shop/customers/:id/followups/:fid/complete", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ id: "fu-1", completedAt: "2026-01-15T10:00:00Z" }),
    );
    await completeAdminCustomerFollowup("user-1", "fu-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/followups/fu-1/complete");
    expect(init.method).toBe("PATCH");
  });

  test("returns the completedAt timestamp on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ id: "fu-1", completedAt: "2026-01-15T10:00:00Z" }),
    );
    const result = await completeAdminCustomerFollowup("user-1", "fu-1");
    expect(result.completedAt).toBe("2026-01-15T10:00:00Z");
  });

  test("throws AdminCustomerFollowupsNotFoundError on 404", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await completeAdminCustomerFollowup("user-1", "missing").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdminCustomerFollowupsNotFoundError);
  });

  test("throws ApiError on 500", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(500, "Internal Server Error", "server error"),
    );
    const err = await completeAdminCustomerFollowup("user-1", "fu-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).method).toBe("PATCH");
  });

  test("URL-encodes both userId and followupId", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "fu/1", completedAt: null }));
    await completeAdminCustomerFollowup("user/1", "fu/1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("user%2F1");
    expect(url).toContain("fu%2F1");
  });
});
