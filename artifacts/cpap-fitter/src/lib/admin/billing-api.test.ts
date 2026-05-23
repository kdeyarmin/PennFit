// Tests for billing-api.ts — the fetch wrappers and format helpers
// introduced in this PR.
//
// Coverage:
//   formatMoneyCents    — pure formatting helper
//   formatPercent       — pure formatting helper
//   getJSON (via fetch wrappers) — URL, headers, credentials, error handling
//   postJSON (via ingestEraFile) — method, headers, body, error paths
//   fetchDirectorSummary / fetchAiQueue / fetchAgingReport /
//   fetchDenialRate / fetchDsoByPayer / fetchEraFiles / ingestEraFile

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  fetchAgingReport,
  fetchAiQueue,
  fetchDenialRate,
  fetchDirectorSummary,
  fetchDsoByPayer,
  fetchEraFiles,
  formatMoneyCents,
  formatPercent,
  ingestEraFile,
} from "./billing-api";

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

// ─── formatMoneyCents ────────────────────────────────────────────────

describe("formatMoneyCents", () => {
  test("returns em-dash for null", () => {
    expect(formatMoneyCents(null)).toBe("—");
  });

  test("returns em-dash for undefined", () => {
    expect(formatMoneyCents(undefined)).toBe("—");
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

  test("formats a typical dollar amount (123456 cents = $1,234.56)", () => {
    expect(formatMoneyCents(123456)).toBe("$1,234.56");
  });

  test("formats 1000000 cents as $10,000.00", () => {
    expect(formatMoneyCents(1_000_000)).toBe("$10,000.00");
  });

  test("formats an odd cent amount with exactly two decimal places", () => {
    // 333 cents = $3.33
    expect(formatMoneyCents(333)).toBe("$3.33");
  });

  test("formats 1 cent as $0.01", () => {
    expect(formatMoneyCents(1)).toBe("$0.01");
  });

  test("formats large amount (999999999 cents = $9,999,999.99)", () => {
    expect(formatMoneyCents(999_999_999)).toBe("$9,999,999.99");
  });
});

// ─── formatPercent ──────────────────────────────────────────────────

describe("formatPercent", () => {
  test("returns em-dash for null", () => {
    expect(formatPercent(null)).toBe("—");
  });

  test("returns em-dash for undefined", () => {
    expect(formatPercent(undefined)).toBe("—");
  });

  test("returns em-dash for NaN", () => {
    expect(formatPercent(NaN)).toBe("—");
  });

  test("formats 0 as 0.0%", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  test("formats 1.0 as 100.0%", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });

  test("formats 0.5 as 50.0%", () => {
    expect(formatPercent(0.5)).toBe("50.0%");
  });

  test("formats 0.123 as 12.3% (1 decimal digit by default)", () => {
    expect(formatPercent(0.123)).toBe("12.3%");
  });

  test("formats 0.1234 with 2 decimal digits when digits=2", () => {
    expect(formatPercent(0.1234, 2)).toBe("12.34%");
  });

  test("formats 0.1234 with 0 decimal digits when digits=0", () => {
    expect(formatPercent(0.1234, 0)).toBe("12%");
  });

  test("formats a very small fraction (0.001 = 0.1%)", () => {
    expect(formatPercent(0.001)).toBe("0.1%");
  });

  test("rounds correctly with 1 decimal (0.126 → 12.6%)", () => {
    expect(formatPercent(0.126)).toBe("12.6%");
  });
});

// ─── Common fetch invariants ─────────────────────────────────────────
//
// Every GET wrapper must:
//   * hit /resupply-api + the expected path
//   * send credentials: "same-origin"
//   * send Accept: application/json
//
// We test those on fetchDirectorSummary as a representative GET wrapper.

describe("getJSON shared behaviour (via fetchDirectorSummary)", () => {
  test("requests the correct URL with /resupply-api prefix", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await fetchDirectorSummary();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/director-summary");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await fetchDirectorSummary();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await fetchDirectorSummary();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("throws Error with the path and status on non-OK response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
    });

    await expect(fetchDirectorSummary()).rejects.toThrow("403");
  });

  test("error message includes the path", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(fetchDirectorSummary()).rejects.toThrow(
      "/admin/billing/director-summary",
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await fetchDirectorSummary();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── fetchDirectorSummary ────────────────────────────────────────────

describe("fetchDirectorSummary", () => {
  test("returns the parsed JSON response", async () => {
    const payload = {
      counts: { staleDrafts: 3 },
      dollars: { stuckSubmittedCents: 5000 },
      denialRateTrend: [],
      topPayersByOpenDollars: [],
      generatedAt: "2026-01-01T00:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const result = await fetchDirectorSummary();
    // @ts-expect-error — minimal fixture intentionally missing fields
    expect(result.counts.staleDrafts).toBe(3);
  });
});

// ─── fetchAiQueue ────────────────────────────────────────────────────

describe("fetchAiQueue", () => {
  test("requests /resupply-api/admin/billing/ai-queue", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scrubBlockingClaims: [],
        scrubFixableClaims: [],
        deniedNeedsAnalysis: [],
        autoResubmitReady: [],
        counts: {
          scrubBlocking: 0,
          scrubFixable: 0,
          deniedNeedsAnalysis: 0,
          autoResubmitReady: 0,
        },
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await fetchAiQueue();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/ai-queue");
  });

  test("returns autoResubmitReady items", async () => {
    const item = {
      analysisId: "aaa",
      claimId: "ccc",
      recommendation: "re-file with corrected NPI",
      confidence: 0.9,
      rootCauseSummary: "Wrong NPI sent",
      createdAt: "2026-01-01T00:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scrubBlockingClaims: [],
        scrubFixableClaims: [],
        deniedNeedsAnalysis: [],
        autoResubmitReady: [item],
        counts: { scrubBlocking: 0, scrubFixable: 0, deniedNeedsAnalysis: 0, autoResubmitReady: 1 },
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const result = await fetchAiQueue();
    expect(result.autoResubmitReady).toHaveLength(1);
    expect(result.autoResubmitReady[0]!.recommendation).toBe(
      "re-file with corrected NPI",
    );
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    await expect(fetchAiQueue()).rejects.toThrow("502");
  });
});

// ─── fetchAgingReport ────────────────────────────────────────────────

describe("fetchAgingReport", () => {
  const BUCKET_ZERO = { claimCount: 0, billedCents: 0 };

  test("requests /resupply-api/admin/billing/aging-report", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        overall: {
          "0_30": BUCKET_ZERO,
          "31_60": BUCKET_ZERO,
          "61_90": BUCKET_ZERO,
          "90_plus": BUCKET_ZERO,
        },
        perPayer: [],
        totalOpenBilledCents: 0,
        totalOpenClaimCount: 0,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await fetchAgingReport();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/aging-report");
  });

  test("returns overall bucket data", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        overall: {
          "0_30": { claimCount: 5, billedCents: 50000 },
          "31_60": BUCKET_ZERO,
          "61_90": BUCKET_ZERO,
          "90_plus": { claimCount: 2, billedCents: 20000 },
        },
        perPayer: [],
        totalOpenBilledCents: 70000,
        totalOpenClaimCount: 7,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const result = await fetchAgingReport();
    expect(result.overall["0_30"].claimCount).toBe(5);
    expect(result.overall["90_plus"].billedCents).toBe(20000);
    expect(result.totalOpenClaimCount).toBe(7);
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(fetchAgingReport()).rejects.toThrow("503");
  });
});

// ─── fetchDenialRate ─────────────────────────────────────────────────

describe("fetchDenialRate", () => {
  test("requests /resupply-api/admin/billing/denial-rate", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        overall: { decisions: 0, denials: 0, denialRate: null },
        perPayer: [],
        windowDays: 90,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await fetchDenialRate();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/denial-rate");
  });

  test("returns perPayer denial rates", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        overall: { decisions: 100, denials: 20, denialRate: 0.2 },
        perPayer: [
          {
            payerName: "Medicare",
            decisions: 60,
            denials: 5,
            denialRate: 0.083,
          },
        ],
        windowDays: 90,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const result = await fetchDenialRate();
    expect(result.overall.denials).toBe(20);
    expect(result.perPayer).toHaveLength(1);
    expect(result.perPayer[0]!.payerName).toBe("Medicare");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchDenialRate()).rejects.toThrow("500");
  });
});

// ─── fetchDsoByPayer ─────────────────────────────────────────────────

describe("fetchDsoByPayer", () => {
  test("requests /resupply-api/admin/billing/dso-by-payer", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payers: [],
        windowDays: 180,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    await fetchDsoByPayer();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/dso-by-payer");
  });

  test("returns payer DSO data including null averageDaysToPay", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        payers: [
          {
            payerName: "Aetna",
            claimCount: 10,
            totalPaidCents: 100000,
            averageDaysToPay: null,
          },
        ],
        windowDays: 180,
        generatedAt: "2026-01-01T00:00:00Z",
      }),
    });

    const result = await fetchDsoByPayer();
    expect(result.payers).toHaveLength(1);
    expect(result.payers[0]!.averageDaysToPay).toBeNull();
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchDsoByPayer()).rejects.toThrow("404");
  });
});

// ─── fetchEraFiles ───────────────────────────────────────────────────

describe("fetchEraFiles", () => {
  test("requests /resupply-api/admin/billing/era-files", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFiles: [] }),
    });

    await fetchEraFiles();

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/era-files");
  });

  test("returns the eraFiles array", async () => {
    const file = {
      id: "era-1",
      fileName: "835_20260101.edi",
      fileSha256: "abc123",
      fileSizeBytes: 2048,
      payerCheckNumber: "CHK-99",
      payerPaidDate: "2026-01-01",
      totalPaidCents: 100000,
      claimsPaidCount: 5,
      claimsDeniedCount: 1,
      linesProcessedCount: 20,
      matchedSubmissionId: null,
      status: "ok",
      rejectionReason: null,
      ingestedByEmail: "admin@example.com",
      ingestedAt: "2026-01-01T12:00:00Z",
    };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFiles: [file] }),
    });

    const result = await fetchEraFiles();
    expect(result.eraFiles).toHaveLength(1);
    expect(result.eraFiles[0]!.fileName).toBe("835_20260101.edi");
    expect(result.eraFiles[0]!.status).toBe("ok");
  });

  test("throws on non-OK response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchEraFiles()).rejects.toThrow("401");
  });
});

// ─── ingestEraFile ───────────────────────────────────────────────────

describe("ingestEraFile", () => {
  const INGEST_INPUT = {
    fileName: "835_test.edi",
    payload: "ISA*00*...",
  };

  test("posts to /resupply-api/admin/billing/era-ingest", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        eraFileId: "era-1",
        status: "ok",
        summary: { claimsMatched: 3, linesProcessed: 10, totalPaidCents: 30000 },
      }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/resupply-api/admin/billing/era-ingest");
  });

  test("uses POST method", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        eraFileId: "era-1",
        status: "ok",
        summary: {},
      }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  test("sends Content-Type: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends Accept: application/json", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json");
  });

  test("sends credentials: same-origin", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("same-origin");
  });

  test("serialises fileName, payload as JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(INGEST_INPUT);
  });

  test("serialises optional matchedSubmissionId when provided", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    const inputWithMatch = {
      ...INGEST_INPUT,
      matchedSubmissionId: "sub-abc-123",
    };
    await ingestEraFile(inputWithMatch);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(inputWithMatch);
  });

  test("returns eraFileId and status from the response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        eraFileId: "era-999",
        status: "ok",
        summary: { claimsMatched: 4, linesProcessed: 8, totalPaidCents: 4000 },
      }),
    });

    const result = await ingestEraFile(INGEST_INPUT);
    expect(result.eraFileId).toBe("era-999");
    expect(result.status).toBe("ok");
    expect(result.summary.claimsMatched).toBe(4);
  });

  test("throws with message field when non-OK response has a message", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: "Duplicate ERA file — already ingested" }),
    });

    await expect(ingestEraFile(INGEST_INPUT)).rejects.toThrow(
      "Duplicate ERA file — already ingested",
    );
  });

  test("throws with error field when non-OK response has error (no message)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: "unparseable_835" }),
    });

    await expect(ingestEraFile(INGEST_INPUT)).rejects.toThrow(
      "unparseable_835",
    );
  });

  test("throws with status only when non-OK response has no parseable JSON", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError("no body");
      },
    });

    await expect(ingestEraFile(INGEST_INPUT)).rejects.toThrow("500");
  });

  test("throws and message includes the path", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({}),
    });

    await expect(ingestEraFile(INGEST_INPUT)).rejects.toThrow(
      "/admin/billing/era-ingest",
    );
  });

  test("calls fetch exactly once", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── CSRF header — postJSON (ingestEraFile) ──────────────────────────────────
//
// The PR added csrfHeader() to postJSON; GET wrappers (getJSON) are unchanged.

describe("CSRF header on postJSON (ingestEraFile)", () => {
  function setDocumentCookie(cookie: string | null) {
    if (cookie === null) {
      delete (globalThis as unknown as { document?: unknown }).document;
    } else {
      (globalThis as unknown as { document?: unknown }).document = { cookie };
    }
  }

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
  });

  test("sends X-PF-CSRF when pf_csrf cookie is present", async () => {
    setDocumentCookie("pf_csrf=billing-csrf-token");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-PF-CSRF"]).toBe("billing-csrf-token");
  });

  test("does not send X-PF-CSRF when pf_csrf cookie is absent", async () => {
    setDocumentCookie("other=unrelated");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ eraFileId: "era-1", status: "ok", summary: {} }),
    });

    await ingestEraFile(INGEST_INPUT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect("X-PF-CSRF" in headers).toBe(false);
  });

  test("GET wrapper (fetchDirectorSummary) does NOT send X-PF-CSRF regardless of cookie", async () => {
    setDocumentCookie("pf_csrf=should-not-attach");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    await fetchDirectorSummary();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // getJSON never calls csrfHeader — only postJSON does.
    expect("X-PF-CSRF" in headers).toBe(false);
  });
});