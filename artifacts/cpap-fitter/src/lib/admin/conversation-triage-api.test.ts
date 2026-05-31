// Tests for conversation-triage-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
//
// Coverage:
//   triageApi.setSnooze   — PATCH /admin/conversations/:id/snooze
//   triageApi.setTags     — PATCH /admin/conversations/:id/tags
//   triageApi.claim       — POST  /admin/conversations/:id/claim
//   triageApi.transcriptCsvUrl — returns URL string (no fetch)

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import { triageApi } from "./conversation-triage-api";

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

function errorResponse(status: number, statusText = ""): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    url: "",
    json: async () => ({}),
  };
}

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
// triageApi.setSnooze
// ---------------------------------------------------------------------------

describe("triageApi.setSnooze", () => {
  test("PATCHes /resupply-api/admin/conversations/:id/snooze", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await triageApi.setSnooze("conv-1", "2026-12-01T00:00:00Z");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/conversations/conv-1/snooze");
    expect(init.method).toBe("PATCH");
  });

  test("serialises snoozedUntil in body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await triageApi.setSnooze("conv-1", "2026-12-01T00:00:00Z");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      snoozedUntil: "2026-12-01T00:00:00Z",
    });
  });

  test("serialises null to clear snooze", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await triageApi.setSnooze("conv-1", null);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ snoozedUntil: null });
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    const result = await triageApi.setSnooze("conv-1", null);
    expect(result).toEqual({ ok: true });
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await triageApi
      .setSnooze("conv-1", null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("ApiError carries method PATCH", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    const err = await triageApi
      .setSnooze("conv-1", null)
      .catch((e: unknown) => e);
    expect((err as ApiError).method).toBe("PATCH");
  });
});

// ---------------------------------------------------------------------------
// triageApi.setTags
// ---------------------------------------------------------------------------

describe("triageApi.setTags", () => {
  test("PATCHes /resupply-api/admin/conversations/:id/tags", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, tags: ["billing"] }));
    await triageApi.setTags("conv-1", ["billing"]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/conversations/conv-1/tags");
    expect(init.method).toBe("PATCH");
  });

  test("serialises tags array in body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, tags: ["a", "b"] }));
    await triageApi.setTags("conv-1", ["a", "b"]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ tags: ["a", "b"] });
  });

  test("accepts an empty tags array (clear tags)", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, tags: [] }));
    const result = await triageApi.setTags("conv-1", []);
    expect(result.tags).toEqual([]);
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(422, "Unprocessable"));
    const err = await triageApi
      .setTags("conv-1", ["invalid-tag"])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// triageApi.claim
// ---------------------------------------------------------------------------

describe("triageApi.claim", () => {
  test("POSTs to /resupply-api/admin/conversations/:id/claim", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await triageApi.claim("conv-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/conversations/conv-1/claim");
    expect(init.method).toBe("POST");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(409, "Conflict"));
    const err = await triageApi.claim("conv-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// triageApi.transcriptCsvUrl — pure URL builder, no fetch
// ---------------------------------------------------------------------------

describe("triageApi.transcriptCsvUrl", () => {
  test("returns the CSV download URL for the given conversation id", () => {
    const url = triageApi.transcriptCsvUrl("conv-abc");
    expect(url).toBe(
      "/resupply-api/admin/conversations/conv-abc/transcript.csv",
    );
  });

  test("does not call fetch", () => {
    triageApi.transcriptCsvUrl("conv-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
