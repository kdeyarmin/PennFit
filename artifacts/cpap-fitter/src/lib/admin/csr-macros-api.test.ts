// Tests for csr-macros-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
//
// Coverage:
//   listMacros    — GET  /admin/csr-macros (with/without includeInactive)
//   createMacro   — POST /admin/csr-macros
//   patchMacro    — PATCH /admin/csr-macros/:id
//   deleteMacro   — DELETE /admin/csr-macros/:id

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  listMacros,
  createMacro,
  patchMacro,
  deleteMacro,
} from "./csr-macros-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function okResponse(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    url: "",
    json: async () => body,
  };
}

function errorResponse(
  status: number,
  statusText = "",
  body: unknown = null,
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

const MACRO = {
  id: "m-1",
  key: "greeting",
  label: "Greeting",
  category: "general",
  body: "Hi {firstName}!",
  channels: ["sms" as const],
  isActive: true,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  updatedBy: null,
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
// listMacros
// ---------------------------------------------------------------------------

describe("listMacros", () => {
  test("GETs /resupply-api/admin/csr-macros", async () => {
    fetchMock.mockResolvedValue(okResponse({ macros: [] }));
    await listMacros();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/csr-macros");
  });

  test("appends ?includeInactive=1 when opts.includeInactive is true", async () => {
    fetchMock.mockResolvedValue(okResponse({ macros: [] }));
    await listMacros({ includeInactive: true });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("includeInactive=1");
  });

  test("does not append includeInactive when false", async () => {
    fetchMock.mockResolvedValue(okResponse({ macros: [] }));
    await listMacros({ includeInactive: false });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("includeInactive");
  });

  test("returns macros array on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ macros: [MACRO] }));
    const result = await listMacros();
    expect(result.macros).toHaveLength(1);
    expect(result.macros[0].key).toBe("greeting");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await listMacros().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    const err = await listMacros().catch((e: unknown) => e);
    expect((err as ApiError).url).toContain("/admin/csr-macros");
  });
});

// ---------------------------------------------------------------------------
// createMacro
// ---------------------------------------------------------------------------

describe("createMacro", () => {
  const CREATE_BODY = {
    key: "farewell",
    label: "Farewell",
    body: "Goodbye!",
    channels: ["email" as const],
  };

  test("POSTs to /resupply-api/admin/csr-macros", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await createMacro(CREATE_BODY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/csr-macros");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await createMacro(CREATE_BODY);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  test("serialises body as JSON", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await createMacro(CREATE_BODY);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject(CREATE_BODY);
  });

  test("returns the new macro on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    const result = await createMacro(CREATE_BODY);
    expect(result.macro.id).toBe("m-1");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(409, "Conflict", { error: "dup_key" }),
    );
    const err = await createMacro(CREATE_BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// patchMacro
// ---------------------------------------------------------------------------

describe("patchMacro", () => {
  test("PATCHes to /resupply-api/admin/csr-macros/:id", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await patchMacro("m-1", { isActive: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/csr-macros/m-1");
    expect(init.method).toBe("PATCH");
  });

  test("URL-encodes the id", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await patchMacro("m/1", { isActive: false });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("m%2F1");
  });

  test("serialises patch body", async () => {
    fetchMock.mockResolvedValue(okResponse({ macro: MACRO }));
    await patchMacro("m-1", { label: "Updated", isActive: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      label: "Updated",
      isActive: true,
    });
  });

  test("throws ApiError with method PATCH on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await patchMacro("m-ghost", { isActive: false }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("PATCH");
    expect((err as ApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// deleteMacro
// ---------------------------------------------------------------------------

describe("deleteMacro", () => {
  test("DELETEs /resupply-api/admin/csr-macros/:id (soft)", async () => {
    fetchMock.mockResolvedValue(okResponse(null));
    await deleteMacro("m-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/csr-macros/m-1");
    expect(url).not.toContain("hard");
    expect(init.method).toBe("DELETE");
  });

  test("appends ?hard=1 when hard=true", async () => {
    fetchMock.mockResolvedValue(okResponse(null));
    await deleteMacro("m-1", true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("?hard=1");
  });

  test("returns undefined (void) on success", async () => {
    fetchMock.mockResolvedValue(okResponse(null));
    const result = await deleteMacro("m-1");
    expect(result).toBeUndefined();
  });

  test("throws ApiError with method DELETE on non-OK response", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(404, "Not Found", { error: "macro_not_found" }),
    );
    const err = await deleteMacro("m-ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("DELETE");
    expect((err as ApiError).status).toBe(404);
  });
});
