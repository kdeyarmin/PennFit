// Tests for lib/admin/therapy-usage-report-api.ts
//
// Coverage:
//   1. fetchTherapyUsageReport() calls the correct URL with groupBy and days params.
//   2. Sends Accept: application/json header.
//   3. Returns the parsed JSON body on success.
//   4. Throws ApiError on a non-ok response.
//   5. ApiError carries the correct HTTP status code.
//   6. ApiError carries the request URL.
//   7. Throws ApiError even when the error body is unparseable.
//   8. Type exports are present in the source.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ApiError } from "@workspace/api-client-react/admin";

import { fetchTherapyUsageReport } from "./therapy-usage-report-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "therapy-usage-report-api.ts"),
  "utf8",
);

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

// ── Type shape ────────────────────────────────────────────────────────────────

describe("therapy-usage-report-api — exported type shapes", () => {
  it("exports TherapyReportGrouping type alias", () => {
    expect(SRC).toContain("TherapyReportGrouping");
  });

  it("TherapyUsageReportResponse interface is exported", () => {
    expect(SRC).toContain("export interface TherapyUsageReportResponse");
  });

  it("TherapyUsageGroup interface is exported", () => {
    expect(SRC).toContain("export interface TherapyUsageGroup");
  });

  it("TherapyUsageSummary interface is exported", () => {
    expect(SRC).toContain("export interface TherapyUsageSummary");
  });

  it("TherapyUsageReportResponse includes generatedAt and windowDays fields", () => {
    const start = SRC.indexOf("export interface TherapyUsageReportResponse");
    const end = SRC.indexOf("\n}", start);
    const body = SRC.slice(start, end);
    expect(body).toContain("generatedAt");
    expect(body).toContain("windowDays");
    expect(body).toContain("grouping");
    expect(body).toContain("summary");
    expect(body).toContain("groups");
  });

  it("TherapyUsageGroup includes all key metric fields", () => {
    const start = SRC.indexOf("export interface TherapyUsageGroup");
    const end = SRC.indexOf("\n}", start);
    const body = SRC.slice(start, end);
    expect(body).toContain("avgUsageHours");
    expect(body).toContain("avgAhi");
    expect(body).toContain("cmsCompliantPatients");
    expect(body).toContain("cmsComplianceRate");
    expect(body).toContain("adherentNightRate");
  });
});

// ── fetchTherapyUsageReport() — URL construction ─────────────────────────────

describe("fetchTherapyUsageReport — URL construction", () => {
  const successResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      windowDays: 30,
      generatedAt: "2026-05-31T00:00:00.000Z",
      grouping: "provider",
      summary: {
        patientCount: 0,
        nightsWithData: 0,
        avgUsageHours: null,
        avgAhi: null,
        avgLeakRateLMin: null,
        adherentNightRate: null,
        cmsCompliantPatients: 0,
        cmsComplianceRate: null,
      },
      groups: [],
    }),
  };

  it("calls the correct base path prefixed with /resupply-api", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("provider", 30);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/resupply-api");
    expect(url).toContain("/admin/reports/therapy-usage");
  });

  it("includes groupBy=provider in the query string", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("provider", 30);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("groupBy=provider");
  });

  it("includes groupBy=patient in the query string", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("patient", 90);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("groupBy=patient");
  });

  it("includes groupBy=manufacturer in the query string", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("manufacturer", 60);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("groupBy=manufacturer");
  });

  it("includes the days parameter in the query string", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("provider", 90);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("days=90");
  });

  it("constructs the exact URL for provider + 30 days", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("provider", 30);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/reports/therapy-usage?groupBy=provider&days=30",
    );
  });

  it("constructs the correct URL for manufacturer + 365 days", async () => {
    fetchMock.mockResolvedValue(successResponse);
    await fetchTherapyUsageReport("manufacturer", 365);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/resupply-api/admin/reports/therapy-usage?groupBy=manufacturer&days=365",
    );
  });
});

// ── fetchTherapyUsageReport() — request headers ───────────────────────────────

describe("fetchTherapyUsageReport — request headers", () => {
  it("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        windowDays: 30,
        generatedAt: "2026-05-31T00:00:00.000Z",
        grouping: "provider",
        summary: {
          patientCount: 0,
          nightsWithData: 0,
          avgUsageHours: null,
          avgAhi: null,
          avgLeakRateLMin: null,
          adherentNightRate: null,
          cmsCompliantPatients: 0,
          cmsComplianceRate: null,
        },
        groups: [],
      }),
    });
    await fetchTherapyUsageReport("provider", 30);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Accept"]).toBe(
      "application/json",
    );
  });
});

// ── fetchTherapyUsageReport() — success path ─────────────────────────────────

describe("fetchTherapyUsageReport — success", () => {
  it("returns the parsed JSON body", async () => {
    const payload = {
      windowDays: 90,
      generatedAt: "2026-05-31T12:00:00.000Z",
      grouping: "provider" as const,
      summary: {
        patientCount: 10,
        nightsWithData: 300,
        avgUsageHours: 5.2,
        avgAhi: 3.1,
        avgLeakRateLMin: 12.5,
        adherentNightRate: 0.82,
        cmsCompliantPatients: 8,
        cmsComplianceRate: 0.8,
      },
      groups: [
        {
          key: "prov-1",
          label: "Dr. Smith",
          sublabel: "NPI 1234567890",
          patientCount: 10,
          nightsWithData: 300,
          avgUsageHours: 5.2,
          avgAhi: 3.1,
          avgLeakRateLMin: 12.5,
          adherentNightRate: 0.82,
          cmsCompliantPatients: 8,
          cmsComplianceRate: 0.8,
        },
      ],
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });
    const result = await fetchTherapyUsageReport("provider", 90);
    expect(result).toEqual(payload);
  });
});

// ── fetchTherapyUsageReport() — error path ───────────────────────────────────

describe("fetchTherapyUsageReport — error handling", () => {
  it("throws ApiError on a 403 response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      url: "",
      json: async () => ({ error: "insufficient_permissions" }),
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
    const err = await fetchTherapyUsageReport("manufacturer", 60).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it("throws ApiError even when the error body is unparseable JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers(),
      url: "",
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    const err = await fetchTherapyUsageReport("patient", 30).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });

  it("ApiError carries the request URL containing the therapy-usage endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers(),
      url: "",
      json: async () => null,
    });
    const err = await fetchTherapyUsageReport("provider", 30).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).url).toContain(
      "/admin/reports/therapy-usage",
    );
  });

  it("does not throw on a 200 response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        windowDays: 30,
        generatedAt: "2026-05-31T00:00:00.000Z",
        grouping: "provider",
        summary: {
          patientCount: 0,
          nightsWithData: 0,
          avgUsageHours: null,
          avgAhi: null,
          avgLeakRateLMin: null,
          adherentNightRate: null,
          cmsCompliantPatients: 0,
          cmsComplianceRate: null,
        },
        groups: [],
      }),
    });
    await expect(
      fetchTherapyUsageReport("provider", 30),
    ).resolves.toBeDefined();
  });
});