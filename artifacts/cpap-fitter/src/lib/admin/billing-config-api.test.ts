// Tests for billing-config-api.ts — fetch wrappers for read-only billing
// configuration admin routes.
//
// Coverage:
//   getJSON shared behaviour   — URL, credentials, Accept header, error handling
//   formatMoneyCents           — pure formatting helper
//   fetchPayerProfiles         — GET /admin/payer-profiles with/without filters
//   fetchPayerFeeSchedules     — GET /admin/payer-fee-schedules
//   fetchPayerModifierRules    — GET /admin/payer-modifier-rules
//   fetchDenialCodes           — GET /admin/denial-codes
//   fetchClaimTemplates        — GET /admin/claim-templates

import { ApiError } from "@workspace/api-client-react/admin";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  fetchPayerProfiles,
  fetchPayerFeeSchedules,
  fetchPayerModifierRules,
  fetchDenialCodes,
  fetchClaimTemplates,
  formatMoneyCents,
  importPayerFeeScheduleCsv,
} from "./billing-config-api";

const ORIGINAL_FETCH = globalThis.fetch;
let fetchMock: Mock;

// Build a non-ok Response-like mock. The fetch wrappers read the body
// via `.text()` to attach it to the thrown ApiError, so a stub needs a
// `text()` method even when the body is empty.
function errorResponse(
  status: number,
  statusText: string,
  body = "",
): Partial<Response> {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    text: async () => body,
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
// formatMoneyCents — pure helper
// ---------------------------------------------------------------------------

describe("formatMoneyCents (billing-config-api)", () => {
  test("returns em-dash for null", () => {
    expect(formatMoneyCents(null)).toBe("—");
  });

  test("returns em-dash for undefined", () => {
    expect(formatMoneyCents(undefined)).toBe("—");
  });

  test("returns em-dash for NaN", () => {
    expect(formatMoneyCents(NaN)).toBe("—");
  });

  test("formats zero as $0.00", () => {
    expect(formatMoneyCents(0)).toBe("$0.00");
  });

  test("formats 100 cents as $1.00", () => {
    expect(formatMoneyCents(100)).toBe("$1.00");
  });

  test("formats 50 cents as $0.50", () => {
    expect(formatMoneyCents(50)).toBe("$0.50");
  });

  test("formats 123456 cents as $1,234.56", () => {
    expect(formatMoneyCents(123456)).toBe("$1,234.56");
  });

  test("formats 1 cent as $0.01", () => {
    expect(formatMoneyCents(1)).toBe("$0.01");
  });

  test("formats 999999999 cents as $9,999,999.99", () => {
    expect(formatMoneyCents(999_999_999)).toBe("$9,999,999.99");
  });
});

// ---------------------------------------------------------------------------
// getJSON shared behaviour (via fetchPayerProfiles)
// ---------------------------------------------------------------------------

describe("getJSON shared behaviour (via fetchPayerProfiles)", () => {
  test("requests /resupply-api prefix on the URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-profiles");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws ApiError carrying the status on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));

    const err = await fetchPayerProfiles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(String(err)).toContain("403");
  });

  test("thrown ApiError exposes status and request URL", async () => {
    fetchMock.mockResolvedValue(errorResponse(404, "Not Found"));

    const err = await fetchPayerProfiles().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).url).toContain("/admin/payer-profiles");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// fetchPayerProfiles
// ---------------------------------------------------------------------------

const SAMPLE_PAYER = {
  id: "payer-1",
  slug: "aetna-hmo",
  displayName: "Aetna HMO",
  payerLegalName: "Aetna Inc.",
  parentOrg: null,
  lineOfBusiness: "commercial",
  region: "northeast",
  officeAllyPayerId: "AETNA1",
  edi5010PayerId: null,
  claimFormat: "electronic",
  paperOnly: false,
  requiresPriorAuthDme: true,
  requiresSignedPaperwork: false,
  priorAuthPhoneE164: "+18005551234",
  claimStatusPhoneE164: null,
  providerPortalUrl: null,
  feeScheduleSource: null,
  notes: null,
  isActive: true,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

describe("fetchPayerProfiles", () => {
  test("requests /resupply-api/admin/payer-profiles with no query string by default", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-profiles");
  });

  test("appends region filter to query string", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles({ region: "northeast" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("region=northeast");
  });

  test("appends multiple filters to query string", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles({ region: "west", active: "true" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("region=west");
    expect(url).toContain("active=true");
  });

  test("omits empty string filter values from query string", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [] }),
    });

    await fetchPayerProfiles({ region: "", q: "aetna" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("region=");
    expect(url).toContain("q=aetna");
  });

  test("returns parsed payerProfiles array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfiles: [SAMPLE_PAYER] }),
    });

    const result = await fetchPayerProfiles();
    expect(result.payerProfiles).toHaveLength(1);
    expect(result.payerProfiles[0]!.slug).toBe("aetna-hmo");
    expect(result.payerProfiles[0]!.requiresPriorAuthDme).toBe(true);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    await expect(fetchPayerProfiles()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// fetchPayerFeeSchedules
// ---------------------------------------------------------------------------

describe("fetchPayerFeeSchedules", () => {
  const SAMPLE_SCHEDULE = {
    id: "fs-1",
    payerProfileId: "payer-1",
    hcpcsCode: "E0601",
    modifier: "KX",
    allowedCents: 50000,
    effectiveFrom: "2025-01-01",
    effectiveThrough: null,
    source: "CMS",
    notes: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  test("requests /resupply-api/admin/payer-fee-schedules", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ feeSchedules: [] }),
    });

    await fetchPayerFeeSchedules();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-fee-schedules");
  });

  test("appends payerProfileId filter when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ feeSchedules: [] }),
    });

    await fetchPayerFeeSchedules({ payerProfileId: "payer-1" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("payerProfileId=payer-1");
  });

  test("appends hcpcs filter when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ feeSchedules: [] }),
    });

    await fetchPayerFeeSchedules({ hcpcs: "E0601" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("hcpcs=E0601");
  });

  test("returns the parsed feeSchedules array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ feeSchedules: [SAMPLE_SCHEDULE] }),
    });

    const result = await fetchPayerFeeSchedules();
    expect(result.feeSchedules).toHaveLength(1);
    expect(result.feeSchedules[0]!.allowedCents).toBe(50000);
    expect(result.feeSchedules[0]!.effectiveThrough).toBeNull();
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(403, "Forbidden"));
    await expect(fetchPayerFeeSchedules()).rejects.toThrow("403");
  });
});

// ---------------------------------------------------------------------------
// fetchPayerModifierRules
// ---------------------------------------------------------------------------

describe("fetchPayerModifierRules", () => {
  test("requests /resupply-api/admin/payer-modifier-rules", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rules: [] }),
    });

    await fetchPayerModifierRules();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-modifier-rules");
  });

  test("appends filters when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rules: [] }),
    });

    await fetchPayerModifierRules({
      payerProfileId: "payer-2",
      hcpcs: "A7030",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("payerProfileId=payer-2");
    expect(url).toContain("hcpcs=A7030");
  });

  test("returns the parsed rules array", async () => {
    const rule = {
      id: "rule-1",
      payerProfileId: "payer-1",
      hcpcsCode: "E0601",
      condition: "always",
      modifiersCsv: "KX",
      priority: 1,
      rationale: null,
      isActive: true,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ rules: [rule] }),
    });

    const result = await fetchPayerModifierRules();
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.modifiersCsv).toBe("KX");
    expect(result.rules[0]!.isActive).toBe(true);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(500, "ISE"));
    await expect(fetchPayerModifierRules()).rejects.toThrow("500");
  });
});

// ---------------------------------------------------------------------------
// fetchDenialCodes
// ---------------------------------------------------------------------------

describe("fetchDenialCodes", () => {
  const SAMPLE_CODE = {
    id: "dc-1",
    codeSystem: "CARC",
    code: "4",
    description: "The service/care is not covered by the plan",
    category: "coverage",
    recommendedAction: "Verify patient eligibility",
    isTerminal: false,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  test("requests /resupply-api/admin/denial-codes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ denialCodes: [] }),
    });

    await fetchDenialCodes();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/denial-codes");
  });

  test("appends codeSystem filter when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ denialCodes: [] }),
    });

    await fetchDenialCodes({ codeSystem: "CARC" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("codeSystem=CARC");
  });

  test("appends q (search) filter when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ denialCodes: [] }),
    });

    await fetchDenialCodes({ q: "eligibility" });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("q=eligibility");
  });

  test("returns parsed denialCodes array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ denialCodes: [SAMPLE_CODE] }),
    });

    const result = await fetchDenialCodes();
    expect(result.denialCodes).toHaveLength(1);
    expect(result.denialCodes[0]!.code).toBe("4");
    expect(result.denialCodes[0]!.isTerminal).toBe(false);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(401, "Unauthorized"));
    await expect(fetchDenialCodes()).rejects.toThrow("401");
  });
});

// ---------------------------------------------------------------------------
// fetchClaimTemplates
// ---------------------------------------------------------------------------

describe("fetchClaimTemplates", () => {
  const SAMPLE_TEMPLATE = {
    id: "tmpl-1",
    slug: "cpap-initial",
    displayName: "CPAP Initial Setup",
    description: "Standard initial CPAP setup",
    lines: [
      {
        hcpcsCode: "E0601",
        modifier: "KX",
        description: "CPAP device",
        chargeCents: 150000,
        quantity: 1,
      },
    ],
    defaultDiagnosisCodes: ["G47.33"],
    scopedPayerProfileId: null,
    isActive: true,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  test("requests /resupply-api/admin/claim-templates", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });

    await fetchClaimTemplates();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/claim-templates");
  });

  test("does not append query parameters (no filters for claim templates)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });

    await fetchClaimTemplates();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/claim-templates");
    expect(url).not.toContain("?");
  });

  test("returns parsed templates array", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [SAMPLE_TEMPLATE] }),
    });

    const result = await fetchClaimTemplates();
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]!.slug).toBe("cpap-initial");
    expect(result.templates[0]!.lines).toHaveLength(1);
    expect(result.templates[0]!.defaultDiagnosisCodes).toContain("G47.33");
  });

  test("returns empty templates array when none exist", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });

    const result = await fetchClaimTemplates();
    expect(result.templates).toEqual([]);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue(errorResponse(503, "Unavailable"));
    await expect(fetchClaimTemplates()).rejects.toThrow("503");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ templates: [] }),
    });

    await fetchClaimTemplates();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// importPayerFeeScheduleCsv — POST /admin/payer-fee-schedules/import-csv
// ---------------------------------------------------------------------------

describe("importPayerFeeScheduleCsv", () => {
  test("POSTs the payer + csv and returns the result on 201", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ accepted: 2, errors: [] }),
    });

    const res = await importPayerFeeScheduleCsv(
      "payer-1",
      "header\nrow1\nrow2",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-fee-schedules/import-csv");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      payerProfileId: "payer-1",
      csv: "header\nrow1\nrow2",
    });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(res).toEqual({ accepted: 2, errors: [] });
  });

  test("returns the row-level errors on a 400 'no valid rows' response (does not throw)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: new Headers(),
      text: async () =>
        JSON.stringify({
          accepted: 0,
          errors: [{ row: 2, reason: "invalid HCPCS: ZZZ" }],
        }),
    });

    const res = await importPayerFeeScheduleCsv("payer-1", "header\nbad");
    expect(res.accepted).toBe(0);
    expect(res.errors).toEqual([{ row: 2, reason: "invalid HCPCS: ZZZ" }]);
  });

  test("throws an ApiError on a 403 (no result envelope)", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(403, "Forbidden", JSON.stringify({ error: "forbidden" })),
    );

    await expect(
      importPayerFeeScheduleCsv("payer-1", "header\nrow"),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
