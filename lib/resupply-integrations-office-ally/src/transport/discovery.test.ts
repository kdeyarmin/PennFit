// Tests for the insurance-discovery transport — a JSON POST of patient
// demographics that returns the list of matched coverages under a v2-style
// envelope ({"data": {"coverages": [...]}}). HTTP outcomes are exercised via
// an injected fake fetch; the request builder, the tolerant response parser,
// and the config reader are covered too.

import { describe, expect, it } from "vitest";

import { readOfficeAllyDiscoveryConfigOrNull } from "../config";
import {
  buildDiscoveryRequestBody,
  createInsuranceDiscoveryTransport,
  extractCoverageRows,
  normalizeCoverage,
  normalizeDate,
} from "./discovery";
import type { FetchLike } from "./realtime";

const CONFIG = {
  url: "https://edi.officeally.io/v2/insurance-discovery",
  apiKey: "test-api-key",
  timeoutMs: 5000,
};

const REQUEST = {
  firstName: "Alice",
  lastName: "Walkin",
  dateOfBirth: "1965-04-12",
  gender: "F" as const,
};

function envelope(coverages: unknown[]): string {
  return JSON.stringify({
    data: {
      responseStatus: { codeValue: "0", description: "Success" },
      coverages,
    },
  });
}

function fakeFetch(
  status: number,
  body: string,
): { fetchImpl: FetchLike; lastInit: () => Parameters<FetchLike>[1] | null } {
  let captured: Parameters<FetchLike>[1] | null = null;
  const fetchImpl: FetchLike = async (_url, init) => {
    captured = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { fetchImpl, lastInit: () => captured };
}

describe("createInsuranceDiscoveryTransport", () => {
  it("reports unavailable (no-op) when config is null", async () => {
    const transport = createInsuranceDiscoveryTransport(null);
    expect(transport.kind).toBe("noop");
    const out = await transport.discover(REQUEST);
    expect(out).toEqual({
      ok: false,
      kind: "unavailable",
      message: "insurance discovery not configured",
    });
  });

  it("sends the api key + JSON body and returns normalized coverages", async () => {
    const { fetchImpl, lastInit } = fakeFetch(
      200,
      envelope([
        {
          payerName: "Acme Health",
          payerId: "OA123",
          memberId: "MEM-1",
          planName: "PPO",
          active: true,
          startDate: "2026-01-01",
        },
        { payer: "Old Plan", memberId: "X9", status: "inactive" },
      ]),
    );
    const transport = createInsuranceDiscoveryTransport(CONFIG, {
      fetchImpl,
      requestId: () => "REQ-1",
    });

    const out = await transport.discover({ ...REQUEST, ssn: "123-45-6789" });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.sessionId).toBe("REQ-1");
    expect(out.coverages).toEqual([
      {
        payerName: "Acme Health",
        payerId: "OA123",
        memberId: "MEM-1",
        planName: "PPO",
        isActive: true,
        coverageStart: "2026-01-01",
        coverageEnd: null,
      },
      {
        payerName: "Old Plan",
        payerId: null,
        memberId: "X9",
        planName: null,
        isActive: false,
        coverageStart: null,
        coverageEnd: null,
      },
    ]);

    const init = lastInit();
    expect(init?.headers.Authorization).toBe("test-api-key");
    const sent = JSON.parse(init?.body ?? "{}");
    expect(sent.firstName).toBe("Alice");
    expect(sent.gender).toBe("F");
    // SSN dashes are stripped to digits.
    expect(sent.ssn).toBe("123456789");
  });

  it("returns an empty coverage list when the search matched nothing", async () => {
    const { fetchImpl } = fakeFetch(200, envelope([]));
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("unreachable");
    expect(out.coverages).toEqual([]);
  });

  it("maps 401/403 to auth_failed", async () => {
    const { fetchImpl } = fakeFetch(403, "");
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "auth_failed" });
  });

  it("maps a non-2xx to rejected with a PHI-free detail", async () => {
    const { fetchImpl } = fakeFetch(500, "internal error");
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "rejected" });
    if (out.ok) throw new Error("unreachable");
    expect(out.message).toMatch(/HTTP 500/);
  });

  it("rejects an invalid-JSON body", async () => {
    const { fetchImpl } = fakeFetch(200, "<<not json>>");
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "rejected" });
  });

  it("rejects a status-only envelope with no coverage list", async () => {
    const body = JSON.stringify({
      data: { responseStatus: { description: "Subject not found" } },
    });
    const { fetchImpl } = fakeFetch(200, body);
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "rejected" });
    if (out.ok) throw new Error("unreachable");
    expect(out.message).toMatch(/Subject not found/);
  });

  it("maps a network throw to connect_failed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("boom");
    };
    const transport = createInsuranceDiscoveryTransport(CONFIG, { fetchImpl });
    const out = await transport.discover(REQUEST);
    expect(out).toMatchObject({ ok: false, kind: "connect_failed" });
  });
});

describe("buildDiscoveryRequestBody", () => {
  it("defaults gender to U and omits absent optionals", () => {
    const body = buildDiscoveryRequestBody({
      firstName: "A",
      lastName: "B",
      dateOfBirth: "1990-01-01",
    });
    expect(body.gender).toBe("U");
    expect(body.ssn).toBeUndefined();
    expect(body.memberId).toBeUndefined();
    expect(body.postalCode).toBeUndefined();
    expect(body.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("passes through service date and strips SSN to digits", () => {
    const body = buildDiscoveryRequestBody({
      firstName: "A",
      lastName: "B",
      dateOfBirth: "1990-01-01",
      ssn: "111-22-3333",
      memberId: " MEM ",
      postalCode: "19103",
      serviceDate: "2026-06-20",
    });
    expect(body.ssn).toBe("111223333");
    expect(body.memberId).toBe("MEM");
    expect(body.postalCode).toBe("19103");
    expect(body.asOfDate).toBe("2026-06-20");
  });
});

describe("extractCoverageRows / normalizeCoverage", () => {
  it("finds the coverage array under common aliases", () => {
    expect(extractCoverageRows({ data: { results: [1] } })).toEqual([1]);
    expect(extractCoverageRows({ data: { matches: [2] } })).toEqual([2]);
    expect(extractCoverageRows({ coverages: [3] })).toEqual([3]);
    expect(extractCoverageRows({ data: {} })).toBeNull();
  });

  it("drops rows with no payer identity", () => {
    expect(normalizeCoverage({ memberId: "X" })).toBeNull();
    expect(normalizeCoverage(null)).toBeNull();
  });

  it("coerces active from boolean and status string", () => {
    expect(normalizeCoverage({ payerName: "P", active: true })?.isActive).toBe(
      true,
    );
    expect(
      normalizeCoverage({ payerName: "P", status: "Active" })?.isActive,
    ).toBe(true);
    expect(
      normalizeCoverage({ payerName: "P", status: "terminated" })?.isActive,
    ).toBe(false);
    // X12 EB01 numeric status.
    expect(normalizeCoverage({ payerName: "P", status: "1" })?.isActive).toBe(
      true,
    );
  });

  it("normalizes coverage dates to ISO (D8 → YYYY-MM-DD), dropping junk", () => {
    // X12 D8 (YYYYMMDD) is converted so the chart's strict ISO date
    // validation accepts the save.
    const d8 = normalizeCoverage({
      payerName: "P",
      startDate: "20240101",
      endDate: "20241231",
    });
    expect(d8?.coverageStart).toBe("2024-01-01");
    expect(d8?.coverageEnd).toBe("2024-12-31");
    // Already-ISO passes through; unparseable becomes null.
    const iso = normalizeCoverage({
      payerName: "P",
      startDate: "2026-06-01",
      endDate: "not-a-date",
    });
    expect(iso?.coverageStart).toBe("2026-06-01");
    expect(iso?.coverageEnd).toBeNull();
  });
});

describe("normalizeDate", () => {
  it("passes ISO through, converts D8, and nulls anything else", () => {
    expect(normalizeDate("2026-06-20")).toBe("2026-06-20");
    expect(normalizeDate("20260620")).toBe("2026-06-20");
    expect(normalizeDate(" 20260620 ")).toBe("2026-06-20");
    expect(normalizeDate("June 20")).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate(null)).toBeNull();
  });
});

describe("readOfficeAllyDiscoveryConfigOrNull", () => {
  it("returns null when stub mode is forced", () => {
    expect(
      readOfficeAllyDiscoveryConfigOrNull({
        OFFICE_ALLY_STUB: "1",
        OFFICE_ALLY_DISCOVERY_URL: CONFIG.url,
        OFFICE_ALLY_REALTIME_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null on a partial config", () => {
    expect(
      readOfficeAllyDiscoveryConfigOrNull({
        OFFICE_ALLY_DISCOVERY_URL: CONFIG.url,
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("rejects a non-Office-Ally or cleartext URL", () => {
    expect(
      readOfficeAllyDiscoveryConfigOrNull({
        OFFICE_ALLY_DISCOVERY_URL: "https://evil.example.com/x",
        OFFICE_ALLY_REALTIME_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      readOfficeAllyDiscoveryConfigOrNull({
        OFFICE_ALLY_DISCOVERY_URL: "http://edi.officeally.io/x",
        OFFICE_ALLY_REALTIME_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("builds the config from env (reusing the realtime key)", () => {
    const cfg = readOfficeAllyDiscoveryConfigOrNull({
      OFFICE_ALLY_DISCOVERY_URL: CONFIG.url,
      OFFICE_ALLY_REALTIME_PASSWORD: "legacy-key",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      url: CONFIG.url,
      apiKey: "legacy-key",
      timeoutMs: 30000,
    });
  });
});
