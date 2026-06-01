// Tests for lib/admin/therapy-usage-report-api.ts
//
// Coverage:
//   1. fetchTherapyUsageReport() builds the correct URL from grouping + days.
//   2. The Accept: application/json header is sent.
//   3. The parsed JSON body is returned on a 200 OK.
//   4. A non-OK response throws an ApiError with the correct status + URL.
//   5. A JSON-parse failure on the error body is handled gracefully.
//   6. All three groupings (provider, patient, manufacturer) produce distinct URLs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import { ApiError } from "@workspace/api-client-react/admin";

import {
  fetchTherapyUsageReport,
  type TherapyUsageReportResponse,
} from "./therapy-usage-report-api";

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

// ─── URL construction ────────────────────────────────────────────────────────

describe("fetchTherapyUsageReport — URL construction", () => {
  it("calls the correct URL for grouping=provider", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("provider"),
    });

    await fetchTherapyUsageReport("provider", 30);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/reports/therapy-usage?groupBy=provider&days=30",
    );
  });

  it("calls the correct URL for grouping=patient", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("patient"),
    });

    await fetchTherapyUsageReport("patient", 90);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/reports/therapy-usage?groupBy=patient&days=90",
    );
  });

  it("calls the correct URL for grouping=manufacturer", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("manufacturer"),
    });

    await fetchTherapyUsageReport("manufacturer", 365);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/reports/therapy-usage?groupBy=manufacturer&days=365",
    );
  });

  it("encodes the days parameter exactly as passed (60, 180, etc.)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("provider"),
    });

    await fetchTherapyUsageReport("provider", 180);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("days=180");
  });

  it("prefixes the URL with /resupply-api", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("provider"),
    });

    await fetchTherapyUsageReport("provider", 30);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^\/resupply-api\//);
  });
});

// ─── Request headers ─────────────────────────────────────────────────────────

describe("fetchTherapyUsageReport — request headers", () => {
  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("provider"),
    });

    await fetchTherapyUsageReport("provider", 30);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });

  it("uses GET (no body, default fetch method)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeOkPayload("provider"),
    });

    await fetchTherapyUsageReport("provider", 30);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // No explicit method means GET; method is undefined or "GET".
    expect(init.method ?? "GET").toBe("GET");
  });
});

// ─── Successful response ─────────────────────────────────────────────────────

describe("fetchTherapyUsageReport — success", () => {
  it("returns the parsed JSON body on a 200 OK", async () => {
    const payload = makeOkPayload("provider");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchTherapyUsageReport("provider", 30);

    expect(result).toEqual(payload);
  });

  it("returns the correct windowDays value from the response body", async () => {
    const payload = makeOkPayload("patient", 90);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchTherapyUsageReport("patient", 90);

    expect(result.windowDays).toBe(90);
  });

  it("returns the groups array from the response body", async () => {
    const payload = makeOkPayload("manufacturer");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchTherapyUsageReport("manufacturer", 30);

    expect(result.groups).toEqual(payload.groups);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("fetchTherapyUsageReport — error handling", () => {
  it("throws ApiError on a 401 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers(),
      url: "",
      json: async () => ({ error: "sign_in_required" }),
    });

    const err = await fetchTherapyUsageReport("provider", 30).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
  });

  it("throws ApiError on a 403 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      url: "",
      json: async () => ({ error: "permission_denied" }),
    });

    const err = await fetchTherapyUsageReport("provider", 30).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });

  it("throws ApiError on a 500 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      url: "",
      json: async () => ({}),
    });

    const err = await fetchTherapyUsageReport("provider", 30).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("ApiError carries the request URL", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      url: "",
      json: async () => null,
    });

    const err = await fetchTherapyUsageReport("patient", 60).catch(
      (e: unknown) => e,
    );

    expect((err as ApiError).url).toContain("/admin/reports/therapy-usage");
  });

  it("handles a non-JSON error body gracefully (still throws ApiError)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      headers: new Headers(),
      url: "",
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });

    const err = await fetchTherapyUsageReport("provider", 30).catch(
      (e: unknown) => e,
    );

    // Even with an unparseable body we still get an ApiError.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOkPayload(
  grouping: TherapyUsageReportResponse["grouping"],
  windowDays = 30,
): TherapyUsageReportResponse {
  return {
    windowDays,
    generatedAt: "2026-05-31T00:00:00.000Z",
    grouping,
    summary: {
      patientCount: 2,
      nightsWithData: 10,
      avgUsageHours: 5.5,
      avgAhi: 3.2,
      avgLeakRateLMin: 8.0,
      adherentNightRate: 0.8,
      cmsCompliantPatients: 1,
      cmsComplianceRate: 0.5,
    },
    groups: [
      {
        key: "bucket-1",
        label: "Bucket 1",
        sublabel: null,
        patientCount: 2,
        nightsWithData: 10,
        avgUsageHours: 5.5,
        avgAhi: 3.2,
        avgLeakRateLMin: 8.0,
        adherentNightRate: 0.8,
        cmsCompliantPatients: 1,
        cmsComplianceRate: 0.5,
      },
    ],
  };
}
