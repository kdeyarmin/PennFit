// Tests for the insurance-claims functions added to clinical-tabs-api.ts
// in the insurance-claims PR.
//
// Coverage:
//   * URL construction (patient + claim IDs are encodeURIComponent-escaped)
//   * HTTP method correctness per endpoint
//   * Request body JSON serialisation
//   * Content-Type header on write operations
//   * Error propagation: non-OK response throws with status message
//   * Regression: special-char IDs in the path are encoded

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

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

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";

function okFetch(body: unknown): void {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

function errorFetch(status: number, body: unknown = { error: "server_error" }): void {
  fetchMock.mockResolvedValue({
    ok: false,
    status,
    statusText: `HTTP ${status}`,
    json: async () => body,
  });
}

// ── listInsuranceClaims ──────────────────────────────────────────────────────

describe("listInsuranceClaims", () => {
  it("GETs /resupply-api/patients/:id/insurance-claims", async () => {
    okFetch({ insuranceClaims: [] });
    await listInsuranceClaims(PATIENT_ID);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("returns the insuranceClaims array from the response", async () => {
    const claims = [{ id: "c1", payerName: "Aetna" }];
    okFetch({ insuranceClaims: claims });
    const result = await listInsuranceClaims(PATIENT_ID);
    expect(result.insuranceClaims).toEqual(claims);
  });

  it("URL-encodes special characters in patientId", async () => {
    okFetch({ insuranceClaims: [] });
    await listInsuranceClaims("patient/with/slashes");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "/resupply-api/patients/patient%2Fwith%2Fslashes/insurance-claims",
    );
  });

  it("throws on non-OK response", async () => {
    errorFetch(404, { error: "not_found" });
    await expect(listInsuranceClaims(PATIENT_ID)).rejects.toThrow();
  });
});

// ── getInsuranceClaim ────────────────────────────────────────────────────────

describe("getInsuranceClaim", () => {
  it("GETs /resupply-api/patients/:id/insurance-claims/:claimId", async () => {
    okFetch({ claim: {}, lineItems: [], events: [] });
    await getInsuranceClaim(PATIENT_ID, CLAIM_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
  });

  it("URL-encodes both patientId and claimId", async () => {
    okFetch({ claim: {}, lineItems: [], events: [] });
    await getInsuranceClaim("pt/1", "cl/2");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "/resupply-api/patients/pt%2F1/insurance-claims/cl%2F2",
    );
  });

  it("returns claim + lineItems + events", async () => {
    const payload = {
      claim: { id: CLAIM_ID, payerName: "Medicare" },
      lineItems: [{ id: "line1" }],
      events: [{ id: "evt1" }],
    };
    okFetch(payload);
    const result = await getInsuranceClaim(PATIENT_ID, CLAIM_ID);
    expect(result.claim).toEqual(payload.claim);
    expect(result.lineItems).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });
});

// ── createInsuranceClaim ─────────────────────────────────────────────────────

describe("createInsuranceClaim", () => {
  const body = {
    payerName: "Aetna",
    dateOfService: "2026-01-15",
  };

  it("POSTs to /resupply-api/patients/:id/insurance-claims", async () => {
    okFetch({ id: "new-claim-id" });
    await createInsuranceClaim(PATIENT_ID, body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims`,
    );
    expect(init.method).toBe("POST");
  });

  it("sends Content-Type: application/json", async () => {
    okFetch({ id: "new-claim-id" });
    await createInsuranceClaim(PATIENT_ID, body);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("serialises the body as JSON", async () => {
    okFetch({ id: "new-claim-id" });
    await createInsuranceClaim(PATIENT_ID, body);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as typeof body;
    expect(parsed.payerName).toBe("Aetna");
    expect(parsed.dateOfService).toBe("2026-01-15");
  });

  it("includes optional fields when provided", async () => {
    okFetch({ id: "new-claim-id" });
    const fullBody = {
      ...body,
      claimNumber: "CLM-001",
      notes: "Initial draft",
      fulfillmentId: "ful-123",
    };
    await createInsuranceClaim(PATIENT_ID, fullBody);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as typeof fullBody;
    expect(parsed.claimNumber).toBe("CLM-001");
    expect(parsed.notes).toBe("Initial draft");
  });

  it("returns the id from the server", async () => {
    okFetch({ id: "returned-id" });
    const result = await createInsuranceClaim(PATIENT_ID, body);
    expect(result.id).toBe("returned-id");
  });

  it("throws on 400 invalid body", async () => {
    errorFetch(400, { error: "invalid_body" });
    await expect(createInsuranceClaim(PATIENT_ID, body)).rejects.toThrow();
  });
});

// ── patchInsuranceClaim ──────────────────────────────────────────────────────

describe("patchInsuranceClaim", () => {
  it("PATCHes /resupply-api/patients/:id/insurance-claims/:claimId", async () => {
    okFetch({ ok: true });
    await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, { status: "submitted" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}`,
    );
    expect(init.method).toBe("PATCH");
  });

  it("sends Content-Type: application/json", async () => {
    okFetch({ ok: true });
    await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, { status: "submitted" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("serialises status transition in the body", async () => {
    okFetch({ ok: true });
    await patchInsuranceClaim(PATIENT_ID, CLAIM_ID, {
      status: "denied",
      denialReason: "Not covered",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      status: string;
      denialReason: string;
    };
    expect(parsed.status).toBe("denied");
    expect(parsed.denialReason).toBe("Not covered");
  });

  it("throws on 409 invalid transition", async () => {
    errorFetch(409, {
      error: "invalid_transition",
      from: "draft",
      to: "paid",
    });
    await expect(
      patchInsuranceClaim(PATIENT_ID, CLAIM_ID, { status: "paid" }),
    ).rejects.toThrow();
  });
});

// ── createInsuranceClaimLine ─────────────────────────────────────────────────

describe("createInsuranceClaimLine", () => {
  const lineBody = {
    hcpcsCode: "E0601",
    billedCents: 15000,
  };

  it("POSTs to /lines sub-path", async () => {
    okFetch({ id: "line-id" });
    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, lineBody);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/lines`,
    );
    expect(init.method).toBe("POST");
  });

  it("serialises hcpcsCode and billedCents", async () => {
    okFetch({ id: "line-id" });
    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, lineBody);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as typeof lineBody;
    expect(parsed.hcpcsCode).toBe("E0601");
    expect(parsed.billedCents).toBe(15000);
  });

  it("includes optional modifier and description when provided", async () => {
    okFetch({ id: "line-id" });
    await createInsuranceClaimLine(PATIENT_ID, CLAIM_ID, {
      ...lineBody,
      modifier: "RR",
      description: "CPAP device rental",
      quantity: 2,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      modifier: string;
      description: string;
      quantity: number;
    };
    expect(parsed.modifier).toBe("RR");
    expect(parsed.description).toBe("CPAP device rental");
    expect(parsed.quantity).toBe(2);
  });

  it("returns the line id from the server", async () => {
    okFetch({ id: "line-xyz" });
    const result = await createInsuranceClaimLine(
      PATIENT_ID,
      CLAIM_ID,
      lineBody,
    );
    expect(result.id).toBe("line-xyz");
  });
});

// ── createInsuranceClaimEvent ────────────────────────────────────────────────

describe("createInsuranceClaimEvent", () => {
  const eventBody = {
    eventType: "note" as const,
  };

  it("POSTs to /events sub-path", async () => {
    okFetch({ id: "evt-id" });
    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, eventBody);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/patients/${PATIENT_ID}/insurance-claims/${CLAIM_ID}/events`,
    );
    expect(init.method).toBe("POST");
  });

  it("serialises eventType in the body", async () => {
    okFetch({ id: "evt-id" });
    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, {
      eventType: "paid",
      amountCents: 12000,
      payerRef: "CHK-9876",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as {
      eventType: string;
      amountCents: number;
      payerRef: string;
    };
    expect(parsed.eventType).toBe("paid");
    expect(parsed.amountCents).toBe(12000);
    expect(parsed.payerRef).toBe("CHK-9876");
  });

  it("sends Content-Type: application/json", async () => {
    okFetch({ id: "evt-id" });
    await createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, eventBody);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("supports all documented event types without throwing", async () => {
    const eventTypes = [
      "submitted",
      "accepted",
      "denied",
      "partial_pay",
      "paid",
      "appealed",
      "closed",
      "note",
    ] as const;

    for (const eventType of eventTypes) {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ id: `evt-${eventType}` }),
      });
      await expect(
        createInsuranceClaimEvent(PATIENT_ID, CLAIM_ID, { eventType }),
      ).resolves.toMatchObject({ id: `evt-${eventType}` });
    }
  });

  it("returns the event id from the server", async () => {
    okFetch({ id: "evt-returned" });
    const result = await createInsuranceClaimEvent(
      PATIENT_ID,
      CLAIM_ID,
      eventBody,
    );
    expect(result.id).toBe("evt-returned");
  });
});