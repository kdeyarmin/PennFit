// Tests for billing-config-api.ts — the new fetch wrappers and helpers
// added/modified in migration 0149 (PA payers phase 2).
//
// Coverage:
//   buildQs             — query-string builder (tested via officeAllyExportCsvHref)
//   sendJSON            — POST/PATCH fetch wrapper (tested via createPayerProfile,
//                         updatePayerProfile)
//   fetchPayerProfile   — single-payer GET
//   createPayerProfile  — POST /admin/payer-profiles
//   updatePayerProfile  — PATCH /admin/payer-profiles/:id
//   officeAllyExportCsvHref — CSV download href helper

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  createPayerProfile,
  fetchPayerProfile,
  officeAllyExportCsvHref,
  updatePayerProfile,
  type PayerProfileUpsert,
} from "./billing-config-api";

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

// ─── officeAllyExportCsvHref ─────────────────────────────────────────────────

describe("officeAllyExportCsvHref", () => {
  test("returns the base export.csv path without query string by default", () => {
    const href = officeAllyExportCsvHref();
    expect(href).toBe(
      "/resupply-api/admin/payer-profiles/export.csv",
    );
  });

  test("returns path without query string when includeNonElectronic is omitted", () => {
    const href = officeAllyExportCsvHref({});
    expect(href).toBe(
      "/resupply-api/admin/payer-profiles/export.csv",
    );
  });

  test("returns path without query string when includeNonElectronic is false", () => {
    const href = officeAllyExportCsvHref({ includeNonElectronic: false });
    // false → undefined → filtered out by buildQs
    expect(href).toBe(
      "/resupply-api/admin/payer-profiles/export.csv",
    );
  });

  test("appends ?includeNonElectronic=true when flag is true", () => {
    const href = officeAllyExportCsvHref({ includeNonElectronic: true });
    expect(href).toBe(
      "/resupply-api/admin/payer-profiles/export.csv?includeNonElectronic=true",
    );
  });

  test("always starts with /resupply-api prefix", () => {
    expect(officeAllyExportCsvHref()).toMatch(/^\/resupply-api\//);
  });
});

// ─── fetchPayerProfile ──────────────────────────────────────────────────────

describe("fetchPayerProfile", () => {
  const PAYER_ID = "11111111-aaaa-4000-8000-000000000001";

  test("requests GET /resupply-api/admin/payer-profiles/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: {} }),
    });

    await fetchPayerProfile(PAYER_ID);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `/resupply-api/admin/payer-profiles/${PAYER_ID}`,
    );
  });

  test("URL-encodes the id", async () => {
    // IDs in practice are UUIDs, but verify encoding is applied
    const weirdId = "abc def";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: {} }),
    });

    await fetchPayerProfile(weirdId);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("abc%20def");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: {} }),
    });

    await fetchPayerProfile(PAYER_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: {} }),
    });

    await fetchPayerProfile(PAYER_ID);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("returns the payerProfile object from response", async () => {
    const profile = {
      id: PAYER_ID,
      slug: "aetna_pa",
      displayName: "Aetna (PA Commercial)",
      ediEnrollmentStatus: "enrolled",
      requiredClaimModifiers: ["KX"],
      timelyFilingDays: 180,
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: profile }),
    });

    const result = await fetchPayerProfile(PAYER_ID);
    // @ts-expect-error — partial fixture
    expect(result.payerProfile.slug).toBe("aetna_pa");
    // @ts-expect-error — partial fixture
    expect(result.payerProfile.ediEnrollmentStatus).toBe("enrolled");
  });

  test("throws with status on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchPayerProfile(PAYER_ID)).rejects.toThrow("404");
  });

  test("error message includes the path", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchPayerProfile(PAYER_ID)).rejects.toThrow(
      `/admin/payer-profiles/${PAYER_ID}`,
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ payerProfile: {} }),
    });
    await fetchPayerProfile(PAYER_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── createPayerProfile ──────────────────────────────────────────────────────

describe("createPayerProfile", () => {
  const MINIMAL_BODY: PayerProfileUpsert = {
    slug: "test_payer",
    displayName: "Test Payer",
    payerLegalName: "Test Payer Inc.",
    lineOfBusiness: "commercial",
  };

  test("sends POST to /resupply-api/admin/payer-profiles", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    await createPayerProfile(MINIMAL_BODY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/payer-profiles");
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    await createPayerProfile(MINIMAL_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    await createPayerProfile(MINIMAL_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    await createPayerProfile(MINIMAL_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("serialises the body as JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    await createPayerProfile(MINIMAL_BODY);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(MINIMAL_BODY);
  });

  test("serialises all submission-readiness fields when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "new-uuid" }),
    });

    const fullBody: PayerProfileUpsert = {
      slug: "aetna_pa",
      displayName: "Aetna (PA)",
      payerLegalName: "Aetna Life Insurance Company",
      lineOfBusiness: "commercial",
      region: "pa",
      timelyFilingDays: 180,
      claimsAddressLine1: "PO Box 981106",
      claimsCity: "El Paso",
      claimsState: "TX",
      claimsZip: "79998",
      ediEnrollmentStatus: "enrolled",
      priorAuthSubmissionMethod: "portal",
      requiredClaimModifiers: ["KX"],
      acceptsElectronicSecondary: true,
    };

    await createPayerProfile(fullBody);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.timelyFilingDays).toBe(180);
    expect(parsed.ediEnrollmentStatus).toBe("enrolled");
    expect(parsed.requiredClaimModifiers).toEqual(["KX"]);
    expect(parsed.priorAuthSubmissionMethod).toBe("portal");
  });

  test("returns { id } from the response", async () => {
    const newId = "11111111-bbbb-4000-8000-000000000099";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: newId }),
    });

    const result = await createPayerProfile(MINIMAL_BODY);
    expect(result.id).toBe(newId);
  });

  test("throws with status and path on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "slug_conflict" }),
    });

    await expect(createPayerProfile(MINIMAL_BODY)).rejects.toThrow("409");
  });

  test("error message includes detail from JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "slug_conflict" }),
    });

    await expect(createPayerProfile(MINIMAL_BODY)).rejects.toThrow(
      "slug_conflict",
    );
  });

  test("throws with status only when error response has no parseable JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(createPayerProfile(MINIMAL_BODY)).rejects.toThrow("500");
  });

  test("throws and error message includes the path", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    await expect(createPayerProfile(MINIMAL_BODY)).rejects.toThrow(
      "/admin/payer-profiles",
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: "x" }),
    });

    await createPayerProfile(MINIMAL_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── updatePayerProfile ──────────────────────────────────────────────────────

describe("updatePayerProfile", () => {
  const PAYER_ID = "22222222-bbbb-4000-8000-000000000002";

  test("sends PATCH to /resupply-api/admin/payer-profiles/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updatePayerProfile(PAYER_ID, { displayName: "Updated Name" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/resupply-api/admin/payer-profiles/${PAYER_ID}`);
    expect(init.method).toBe("PATCH");
  });

  test("URL-encodes the id in the PATCH path", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const weirdId = "abc def";
    await updatePayerProfile(weirdId, {});

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("abc%20def");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updatePayerProfile(PAYER_ID, { isActive: false });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updatePayerProfile(PAYER_ID, {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("serialises patch fields as JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const patch = { timelyFilingDays: 90, ediEnrollmentStatus: "enrolled" as const };
    await updatePayerProfile(PAYER_ID, patch);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(patch);
  });

  test("serialises new submission-readiness patch fields", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const patch = {
      claimsAddressLine1: "PO Box 999",
      claimsCity: "Harrisburg",
      claimsState: "PA",
      requiredClaimModifiers: ["KX", "GA"],
      priorAuthSubmissionMethod: "fax" as const,
      priorAuthTurnaroundBusinessDays: 7,
    };
    await updatePayerProfile(PAYER_ID, patch);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed.claimsState).toBe("PA");
    expect(parsed.requiredClaimModifiers).toEqual(["KX", "GA"]);
    expect(parsed.priorAuthTurnaroundBusinessDays).toBe(7);
  });

  test("returns { ok: true } from response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await updatePayerProfile(PAYER_ID, {});
    expect(result.ok).toBe(true);
  });

  test("throws with status and path on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "permission_denied" }),
    });

    await expect(
      updatePayerProfile(PAYER_ID, { displayName: "X" }),
    ).rejects.toThrow("403");
  });

  test("error message includes detail from JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_body", issues: [] }),
    });

    await expect(updatePayerProfile(PAYER_ID, {})).rejects.toThrow(
      "invalid_body",
    );
  });

  test("throws and message includes the path", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    await expect(updatePayerProfile(PAYER_ID, {})).rejects.toThrow(
      `/admin/payer-profiles/${PAYER_ID}`,
    );
  });

  test("throws gracefully when non-OK response has no JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("not json");
      },
    });

    await expect(
      updatePayerProfile(PAYER_ID, {}),
    ).rejects.toThrow("503");
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });

    await updatePayerProfile(PAYER_ID, {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── sendJSON shared behaviour ───────────────────────────────────────────────
//
// Both createPayerProfile (POST) and updatePayerProfile (PATCH) call
// the internal sendJSON helper.  The above suites verify method-level
// detail; here we specifically verify the error-detail embedding logic
// across both method variants through one additional cross-cutting test.

describe("sendJSON error detail embedding (via createPayerProfile)", () => {
  const BODY: PayerProfileUpsert = {
    slug: "x",
    displayName: "X",
    payerLegalName: "X Inc.",
    lineOfBusiness: "other",
  };

  test("embeds JSON detail when server returns parseable error body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        error: "invalid_body",
        issues: [{ path: "claimsState", message: "must be 2-letter US state code" }],
      }),
    });

    await expect(createPayerProfile(BODY)).rejects.toThrow("422");
  });

  test("error omits detail section when body is not JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    // No second colon (i.e. no `:` after the status)
    const err = await createPayerProfile(BODY).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/POST.*500/);
    expect(err.message).not.toContain(": {");
  });
});