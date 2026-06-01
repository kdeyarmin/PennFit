// Tests for coaching-plans-api.ts.
//
// This PR migrated `throw new Error(...)` to `throw new ApiError(...)`.
//
// Coverage:
//   listCoachingPlans   — GET /admin/coaching-plans
//   createCoachingPlan  — POST /admin/coaching-plans
//   patchCoachingPlan   — PATCH /admin/coaching-plans/:id

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  listCoachingPlans,
  createCoachingPlan,
  patchCoachingPlan,
} from "./coaching-plans-api";

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

const PLAN = {
  id: "plan-1",
  patientId: "pt-1",
  sourceAlertId: null,
  openedByUserId: "sup-1",
  status: "open" as const,
  targetCompliancePct: 70,
  latestCompliancePct: null,
  targetDate: null,
  latestOutreachAt: null,
  resolutionNote: null,
  openedAt: "2026-01-01T00:00:00Z",
  closedAt: null,
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
// listCoachingPlans
// ---------------------------------------------------------------------------

describe("listCoachingPlans", () => {
  test("GETs /resupply-api/admin/coaching-plans without query by default", async () => {
    fetchMock.mockResolvedValue(okResponse({ plans: [] }));
    await listCoachingPlans();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/coaching-plans");
    expect(url).not.toContain("include=closed");
  });

  test("appends ?include=closed when includeClosed is true", async () => {
    fetchMock.mockResolvedValue(okResponse({ plans: [] }));
    await listCoachingPlans(true);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/coaching-plans?include=closed");
  });

  test("returns the plans array on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ plans: [PLAN] }));
    const result = await listCoachingPlans();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].status).toBe("open");
  });

  test("throws ApiError on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    const err = await listCoachingPlans().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    const err = await listCoachingPlans().catch((e: unknown) => e);
    expect((err as ApiError).url).toContain("/admin/coaching-plans");
  });
});

// ---------------------------------------------------------------------------
// createCoachingPlan
// ---------------------------------------------------------------------------

describe("createCoachingPlan", () => {
  const CREATE_BODY = { patientId: "pt-1" };

  test("POSTs to /resupply-api/admin/coaching-plans", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "plan-new" }));
    await createCoachingPlan(CREATE_BODY);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/coaching-plans");
    expect(init.method).toBe("POST");
  });

  test("serialises the body as JSON", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "plan-new" }));
    await createCoachingPlan(CREATE_BODY);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject(CREATE_BODY);
  });

  test("returns the new plan id on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ id: "plan-abc" }));
    const result = await createCoachingPlan(CREATE_BODY);
    expect(result.id).toBe("plan-abc");
  });

  test("throws ApiError with method POST on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(422, "Unprocessable Entity"));
    const err = await createCoachingPlan(CREATE_BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// patchCoachingPlan
// ---------------------------------------------------------------------------

describe("patchCoachingPlan", () => {
  test("PATCHes to /resupply-api/admin/coaching-plans/:id", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await patchCoachingPlan("plan-1", { status: "improving" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/coaching-plans/plan-1");
    expect(init.method).toBe("PATCH");
  });

  test("serialises patch body as JSON", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await patchCoachingPlan("plan-1", {
      status: "resolved",
      resolutionNote: "Improved",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      status: "resolved",
      resolutionNote: "Improved",
    });
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    const result = await patchCoachingPlan("plan-1", { status: "abandoned" });
    expect(result).toEqual({ ok: true });
  });

  test("throws ApiError with method PATCH on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));
    const err = await patchCoachingPlan("missing", {
      status: "resolved",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("PATCH");
    expect((err as ApiError).status).toBe(404);
  });

  test("can null out optional fields", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await patchCoachingPlan("plan-1", { targetDate: null });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ targetDate: null });
  });
});
