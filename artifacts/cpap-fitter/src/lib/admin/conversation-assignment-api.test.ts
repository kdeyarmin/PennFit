// Tests for conversation-assignment-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
//
// Coverage:
//   claimConversation      — POST /conversations/:id/claim
//   releaseConversation    — POST /conversations/:id/release
//   assignConversation     — POST /conversations/:id/assign
//   setConversationPriority — POST /conversations/:id/priority
//   escalateConversation   — POST /conversations/:id/escalate
//   deEscalateConversation — POST /conversations/:id/de-escalate
//   setConversationStatus  — POST /conversations/:id/status

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  claimConversation,
  releaseConversation,
  assignConversation,
  setConversationPriority,
  escalateConversation,
  deEscalateConversation,
  setConversationStatus,
} from "./conversation-assignment-api";

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

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// claimConversation
// ---------------------------------------------------------------------------

describe("claimConversation", () => {
  test("POSTs to /resupply-api/conversations/:id/claim", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await claimConversation("conv-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/conversations/conv-1/claim");
    expect(init.method).toBe("POST");
  });

  test("appends ?force=1 when force=true", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await claimConversation("conv-1", true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("?force=1");
  });

  test("does not append force flag by default", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await claimConversation("conv-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("force");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(409, "Conflict"));
    const err = await claimConversation("conv-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// releaseConversation
// ---------------------------------------------------------------------------

describe("releaseConversation", () => {
  test("POSTs to /resupply-api/conversations/:id/release", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await releaseConversation("conv-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/conversations/conv-1/release");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await releaseConversation("conv-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// assignConversation
// ---------------------------------------------------------------------------

describe("assignConversation", () => {
  test("POSTs to /resupply-api/conversations/:id/assign", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await assignConversation("conv-1", "user-2");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/conversations/conv-1/assign");
  });

  test("sends userId in body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await assignConversation("conv-1", "user-2");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ userId: "user-2" });
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await assignConversation("conv-1", "ghost").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// setConversationPriority
// ---------------------------------------------------------------------------

describe("setConversationPriority", () => {
  test("POSTs the priority in body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await setConversationPriority("conv-1", "urgent");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/priority");
    expect(JSON.parse(init.body as string)).toEqual({ priority: "urgent" });
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    const err = await setConversationPriority("conv-1", "high").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// escalateConversation
// ---------------------------------------------------------------------------

describe("escalateConversation", () => {
  test("POSTs reason in body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await escalateConversation("conv-1", { reason: "Needs supervisor" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      reason: "Needs supervisor",
    });
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await escalateConversation("conv-1", {
      reason: "test",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// deEscalateConversation
// ---------------------------------------------------------------------------

describe("deEscalateConversation", () => {
  test("POSTs to the de-escalate URL", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await deEscalateConversation("conv-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/de-escalate");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await deEscalateConversation("conv-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// setConversationStatus
// ---------------------------------------------------------------------------

describe("setConversationStatus", () => {
  test("POSTs the status in body", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ok: true, status: "closed", changed: true }),
    );
    await setConversationStatus("conv-1", "closed");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/status");
    expect(JSON.parse(init.body as string)).toEqual({ status: "closed" });
  });

  test("returns the typed response on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ ok: true, status: "awaiting_patient", changed: false }),
    );
    const result = await setConversationStatus("conv-1", "awaiting_patient");
    expect(result.changed).toBe(false);
    expect(result.status).toBe("awaiting_patient");
  });

  test("throws ApiError on 409 (wrong_channel)", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(409, "Conflict", { error: "wrong_channel" }),
    );
    const err = await setConversationStatus("conv-sms", "closed").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });
});