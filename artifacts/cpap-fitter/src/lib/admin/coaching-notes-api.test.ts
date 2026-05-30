// Tests for coaching-notes-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
//
// Coverage:
//   listConversationCoachingNotes   — GET  /admin/conversations/:id/coaching-notes
//   createConversationCoachingNote  — POST /admin/conversations/:id/coaching-notes
//   listTeamCoachingNotes           — GET  /admin/team/:id/coaching-notes

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  listConversationCoachingNotes,
  createConversationCoachingNote,
  listTeamCoachingNotes,
} from "./coaching-notes-api";

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
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    url: "",
    json: async () => ({}),
  };
}

const NOTE = {
  id: "note-1",
  conversationId: "conv-1",
  targetUserId: "user-1",
  authorUserId: "sup-1",
  kind: "praise" as const,
  body: "Great job!",
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
// listConversationCoachingNotes
// ---------------------------------------------------------------------------

describe("listConversationCoachingNotes", () => {
  test("GETs /resupply-api/admin/conversations/:id/coaching-notes", async () => {
    fetchMock.mockResolvedValue(okResponse({ notes: [] }));
    await listConversationCoachingNotes("conv-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/conversations/conv-1/coaching-notes",
    );
  });

  test("URL-encodes the conversationId", async () => {
    fetchMock.mockResolvedValue(okResponse({ notes: [] }));
    await listConversationCoachingNotes("conv/1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("conv%2F1");
  });

  test("returns the notes array on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ notes: [NOTE] }));
    const result = await listConversationCoachingNotes("conv-1");
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].kind).toBe("praise");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await listConversationCoachingNotes("conv-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// createConversationCoachingNote
// ---------------------------------------------------------------------------

describe("createConversationCoachingNote", () => {
  const CREATE_BODY = {
    targetUserId: "user-1",
    kind: "suggestion" as const,
    body: "Consider slowing down",
  };

  test("POSTs to the coaching-notes URL", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "note-new" }));
    await createConversationCoachingNote("conv-1", CREATE_BODY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/conversations/conv-1/coaching-notes",
    );
    expect(init.method).toBe("POST");
  });

  test("serialises the body as JSON", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "note-new" }));
    await createConversationCoachingNote("conv-1", CREATE_BODY);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(CREATE_BODY);
  });

  test("returns the new note id on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "note-abc" }));
    const result = await createConversationCoachingNote("conv-1", CREATE_BODY);
    expect(result.id).toBe("note-abc");
  });

  test("throws ApiError with method POST on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(422, "Unprocessable Entity"));
    const err = await createConversationCoachingNote(
      "conv-1",
      CREATE_BODY,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("POST");
    expect((err as ApiError).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// listTeamCoachingNotes
// ---------------------------------------------------------------------------

describe("listTeamCoachingNotes", () => {
  test("GETs /resupply-api/admin/team/:id/coaching-notes", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ counts: {}, notes: [] }),
    );
    await listTeamCoachingNotes("user-1");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/team/user-1/coaching-notes");
  });

  test("returns counts and notes on success", async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        counts: { praise: 2, suggestion: 1 },
        notes: [NOTE],
      }),
    );
    const result = await listTeamCoachingNotes("user-1");
    expect(result.counts["praise"]).toBe(2);
    expect(result.notes).toHaveLength(1);
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await listTeamCoachingNotes("missing").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});