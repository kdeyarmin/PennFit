// Tests for the insurance-claims fetch wrappers in clinical-tabs-api.ts.
//
// These are the only functions added to this file in the current PR.
// We cover:
//   listInsuranceClaims      — GET  /patients/:id/insurance-claims
//   getInsuranceClaim        — GET  /patients/:id/insurance-claims/:claimId
//   createInsuranceClaim     — POST /patients/:id/insurance-claims
//   patchInsuranceClaim      — PATCH /patients/:id/insurance-claims/:claimId
//   createInsuranceClaimLine — POST /patients/:id/insurance-claims/:claimId/lines
//   createInsuranceClaimEvent— POST /patients/:id/insurance-claims/:claimId/events
//
// jsonFetch: all six wrappers delegate to jsonFetch which:
//   * prefixes paths with /resupply-api
//   * sends Accept: application/json
//   * on non-OK: tries JSON, extracts message/error, falls back to
//     "${status} ${statusText}"
//   * returns parsed JSON on success

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  createInsuranceClaim,
  createInsuranceClaimEvent,
  createInsuranceClaimLine,
  getInsuranceClaim,
  listInsuranceClaims,
  patchInsuranceClaim,
} from "./clinical-tabs-api";

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

// ── Test IDs ─────────────────────────────────────────────────────────
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const LINE_ID = "33333333-3333-4333-8333-333333333333";

// Minimal claim fixture matching the InsuranceClaim interface.
const CLAIM_ROW = {
  id: CLAIM_ID,
  insuranceCoverageId: null,
  payerName: "Medicare Part B",
  claimNumber: null,
  dateOfService: "2026-01-15",
  fulfillmentId: null,
  status: "draft" as const,
  totalBilledCents: 0,
  totalAllowedCents: 0,
  totalPaidCents: 0,
  patientResponsibilityCents: 0,
  submittedAt: null,
  decisionAt: null,
  paidAt: null,
  denialReason: null,
  notes: null,
  createdAt: "2026-01-15T10:00:00Z",
  updatedAt: "2026-01-15T10:00:00Z",
};

// ── listInsuranceClaims ───────────────────────────────────────────────
describe("listInsuranceClaims", () => {
  test("requests the correct URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ insuranceClaims: [] }),
    });

    await listInsuranceClaims(PATIENT_ID);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`);
  });

  test("uses GET method (default)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ insuranceClaims: [] }),
    });

    await listInsuranceClaims(PATIENT_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // No explicit method means GET for jsonFetch
    expect(init.method).toBeUndefined();
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ insuranceClaims: [] }),
    });

    await listInsuranceClaims(PATIENT_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("returns the parsed insuranceClaims array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ insuranceClaims: [CLAIM_ROW] }),
    });

    const result = await listInsuranceClaims(PATIENT_ID);
    expect(result.insuranceClaims).toHaveLength(1);
    expect(result.insuranceClaims[0].id).toBe(CLAIM_ID);
  });

  test("URL-encodes a patient id that contains special characters", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ insuranceClaims: [] }),
    });

    await listInsuranceClaims("id/with spaces");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("id%2Fwith%20spaces");
  });

  test("throws an Error with status text on non-OK response without JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(listInsuranceClaims(PATIENT_ID)).rejects.toThrow("401");
  });

  test("throws an Error with the JSON error field on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ error: "permission_denied" }),
    });

    await expect(listInsuranceClaims(PATIENT_ID)).rejects.toThrow(
      "permission_denied",
    );
  });
});

// ── getInsuranceClaim ─────────────────────────────────────────────────
describe("getInsuranceClaim", () => {
  const LINE_ROW = {
    id: LINE_ID,
    hcpcsCode: "E0601",
    modifier: null,
    description: "CPAP device",
    quantity: 1,
    billedCents: 50000,
    allowedCents: 40000,
    paidCents: 0,
    status: "pending" as const,
    denialReason: null,
    createdAt: "2026-01-15T10:00:00Z",
    updatedAt: "2026-01-15T10:00:00Z",
  };

  test("requests the correct URL including claimId", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ claim: CLAIM_ROW, lineItems: [], events: [] }),
    });

    await getInsuranceClaim(PATIENT_ID, CLAIM_ID);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
  });

  test("returns claim, lineItems, and events", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        claim: CLAIM_ROW,
        lineItems: [LINE_ROW],
        events: [],
      }),
    });

    const result = await getInsuranceClaim(PATIENT_ID, CLAIM_ID);
    expect(result.claim.id).toBe(CLAIM_ID);
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].hcpcsCode).toBe("E0601");
    expect(result.events).toHaveLength(0);
  });

  test("throws on non-OK (404 not found)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "not_found" }),
    });

    await expect(getInsuranceClaim(PATIENT_ID, CLAIM_ID)).rejects.toThrow(
      "not_found",
    );
  });
});

// ── createInsuranceClaim ─────────────────────────────────────────────
describe("createInsuranceClaim", () => {
  const CREATE_BODY = {
    payerName: "Aetna",
    dateOfService: "2026-02-01",
    claimNumber: null,
    notes: null,
  };

  test("posts to the correct URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: CLAIM_ID }),
    });

    await createInsuranceClaim(PATIENT_ID, CREATE_BODY);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/resupply-api/patients/${PATIENT_ID}/insurance-claims`);
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: CLAIM_ID }),
    });

    await createInsuranceClaim(PATIENT_ID, CREATE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: CLAIM_ID }),
    });

    await createInsuranceClaim(PATIENT_ID, CREATE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("serialises body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: CLAIM_ID }),
    });

    await createInsuranceClaim(PATIENT_ID, CREATE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(CREATE_BODY);
  });

  test("returns the new claim id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: CLAIM_ID }),
    });

    const result = await createInsuranceClaim(PATIENT_ID, CREATE_BODY);
    expect(result.id).toBe(CLAIM_ID);
  });

  test("throws on 400 validation error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_body" }),
    });

    await expect(createInsuranceClaim(PATIENT_ID, CREATE_BODY)).rejects.toThrow(
      "invalid_body",
    );
  });
});

// ── patchInsuranceClaim ───────────────────────────────────────────────
describe("patchInsuranceClaim", () => {
  const PATCH_BODY = { status: "submitted" as const };

  test("sends PATCH to the correct URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, PATCH_BODY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(init.method).toBe("PATCH");
  });

  test("serialises the patch body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, PATCH_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(PATCH_BODY);
  });

  test("returns { ok: true } on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, PATCH_BODY);
    expect(result).toEqual({ ok: true });
  });

  test("throws on 409 invalid-transition", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ error: "invalid_transition" }),
    });

    await expect(
      patchInsuranceClaim(PATIENT_ID, CLAIM_ID, PATCH_BODY),
    ).rejects.toThrow("invalid_transition");
  });
});

// ── createInsuranceClaimLine ─────────────────────────────────────────
describe("createInsuranceClaimLine", () => {
  const LINE_BODY = { hcpcsCode: "E0601", billedCents: 50000 };

  test("posts to the /lines sub-resource", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: LINE_ID }),
    });

    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, LINE_BODY);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
    );
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: LINE_ID }),
    });

    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, LINE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("serialises body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: LINE_ID }),
    });

    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, LINE_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(LINE_BODY);
  });

  test("returns the new line item id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: LINE_ID }),
    });

    const result = await createInsuranceClaimLine(
      PATIENT_ID,
      CLAIM_ID,
      LINE_BODY,
    );
    expect(result.id).toBe(LINE_ID);
  });

  test("throws on invalid HCPCS body (400)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_body" }),
    });

    await expect(
      createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, LINE_BODY),
    ).rejects.toThrow("invalid_body");
  });
});

// ── createInsuranceClaimEvent ─────────────────────────────────────────
describe("createInsuranceClaimEvent", () => {
  const EVENT_ID = "44444444-4444-4444-8444-444444444444";
  const EVENT_BODY = { eventType: "note" as const, note: "EOB received" };

  test("posts to the /events sub-resource", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: EVENT_ID }),
    });

    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, EVENT_BODY);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
    );
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: EVENT_ID }),
    });

    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, EVENT_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("serialises body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: EVENT_ID }),
    });

    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, EVENT_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(EVENT_BODY);
  });

  test("returns the new event id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: EVENT_ID }),
    });

    const result = await createInsuranceClaimEvent(
      PATIENT_ID,
      CLAIM_ID,
      EVENT_BODY,
    );
    expect(result.id).toBe(EVENT_ID);
  });

  test("serialises all optional fields in the body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: EVENT_ID }),
    });

    const fullBody = {
      eventType: "paid" as const,
      amountCents: 40000,
      payerRef: "CHECK-12345",
      documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      note: "Final payment",
    };
    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, fullBody);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(fullBody);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
      json: async () => ({ error: "not_found" }),
    });

    await expect(
      createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, EVENT_BODY),
    ).rejects.toThrow("not_found");
  });

  test("uses message field from JSON error body when present", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ message: "Event type is required" }),
    });

    await expect(
      createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, EVENT_BODY),
    ).rejects.toThrow("Event type is required");
  });
});

// ---------------------------------------------------------------------------
// ApiError migration — jsonFetch now throws ApiError (not plain Error)
// ---------------------------------------------------------------------------

describe("clinical-tabs-api — ApiError thrown on non-OK response", () => {
  test("listInsuranceClaims throws ApiError instance on 403", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await listInsuranceClaims(PATIENT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  test("createInsuranceClaim throws ApiError with method POST", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await createInsuranceClaim(PATIENT_ID, {
      payerName: "Aetna",
      dateOfService: "2026-02-01",
      claimNumber: null,
      notes: null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("POST");
  });

  test("patchInsuranceClaim throws ApiError with method PATCH", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });
    const err = await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, {
      status: "submitted",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).method).toBe("PATCH");
  });

  test("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "ISE",
      headers: new Headers(),
      url: "",
      json: async () => null,
    });
    const err = await listInsuranceClaims(PATIENT_ID).catch((e: unknown) => e);
    expect((err as ApiError).url).toContain("/insurance-claims");
  });
});
