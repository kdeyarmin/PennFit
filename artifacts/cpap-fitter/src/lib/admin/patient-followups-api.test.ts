// Tests for patient-followups-api.ts client wrappers.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  completeAdminPatientFollowup,
  reopenAdminPatientFollowup,
  AdminPatientFollowupsNotFoundError,
} from "./patient-followups-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

function okResponse(body: unknown): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    url: "/resupply-api/patients/patient-1/followups",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function errorResponse(status: number, body = ""): Partial<Response> {
  return {
    ok: false,
    status,
    headers: new Headers(),
    url: "/resupply-api/patients/patient-1/followups",
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

describe("completeAdminPatientFollowup", () => {
  test("PATCHes to /patients/:id/followups/:fid/complete", async () => {
    fetchMock.mockResolvedValue(
      okResponse({ id: "fu-1", completedAt: "2026-01-15T10:00:00Z" }),
    );
    await completeAdminPatientFollowup("patient-1", "fu-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/patients/patient-1/followups/fu-1/complete");
    expect(init.method).toBe("PATCH");
  });

  test("throws AdminPatientFollowupsNotFoundError on 404", async () => {
    fetchMock.mockResolvedValue(errorResponse(404));
    const err = await completeAdminPatientFollowup(
      "patient-1",
      "missing",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminPatientFollowupsNotFoundError);
  });
});

describe("reopenAdminPatientFollowup", () => {
  test("PATCHes to /patients/:id/followups/:fid/reopen", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "fu-1", completedAt: null }));
    await reopenAdminPatientFollowup("patient-1", "fu-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/patients/patient-1/followups/fu-1/reopen");
    expect(init.method).toBe("PATCH");
  });

  test("returns null completedAt on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "fu-1", completedAt: null }));
    const result = await reopenAdminPatientFollowup("patient-1", "fu-1");
    expect(result.completedAt).toBeNull();
  });

  test("throws ApiError on non-404 failures", async () => {
    fetchMock.mockResolvedValue(errorResponse(409, "already open"));
    const err = await reopenAdminPatientFollowup("patient-1", "fu-1").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
  });
});
