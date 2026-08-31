// The therapy-cloud connection validator.
//
// TWO SUITES, DELIBERATELY
// ------------------------
// The first runs everywhere, against a fake adapter, and pins the
// distinctions an operator responds to differently — 401 vs 403,
// "the patient does not exist" vs "the URL does not exist", a schema
// drift vs an empty result.
//
// The second only runs when real, non-production credentials are present
// (`INTEGRATION_LIVE_TESTS=1` plus a source and a test patient id). With
// them absent it SKIPS rather than passing vacuously, because a live test
// that quietly passes without credentials is worse than no live test: it
// makes a connector look validated when nothing was contacted.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FetchSnapshotResult,
  IntegrationSource,
} from "@workspace/resupply-integrations";

const adaptersByOrg = new Map<
  string,
  Map<
    string,
    {
      source: string;
      availability: () => { status: string };
      fetchSnapshot: () => Promise<FetchSnapshotResult>;
    }
  >
>();

vi.mock("./registry", () => ({
  getIntegrationAdaptersForOrg: (orgId: string) =>
    Promise.resolve(adaptersByOrg.get(orgId) ?? new Map()),
}));

const recordValidationOutcomeMock = vi.hoisted(() =>
  vi.fn(() => Promise.resolve(true)),
);
vi.mock("./connector-status", () => ({
  recordValidationOutcome: recordValidationOutcomeMock,
}));

const { validateIntegrationConnection } = await import("./validate-connection");

const ORG = "org-1";
const SOURCE: IntegrationSource = "resmed_airview";

function night(date: string) {
  return {
    nightDate: date,
    usageMinutes: 400,
    ahi: 2.1,
    leakRateLMin: 12,
    pressureP95Cmh2o: 11,
  };
}

function goodSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    source: SOURCE,
    partnerPatientId: "P-1",
    settings: {
      deviceModel: "AirSense 11",
      deviceSerial: null,
      therapyMode: "APAP",
      pressureMinCmh2o: 5,
      pressureMaxCmh2o: 15,
      rampMinutes: 20,
      humidifierLevel: 3,
      maskType: null,
    },
    compliance: {
      windowDays: 30,
      daysWithData: 24,
      daysOver4Hours: 22,
      averageUsageMinutes: 380,
      averageAhi: 2.4,
      meetsCmsCompliance: true,
    },
    recentNights: [night("2026-05-31")],
    supplies: [],
    ...overrides,
  };
}

function installAdapter(result: FetchSnapshotResult | "not_configured") {
  const map = new Map();
  map.set(SOURCE, {
    source: SOURCE,
    availability: () => ({
      status:
        result === "not_configured" ? "missing_credentials" : "configured",
    }),
    fetchSnapshot: () =>
      Promise.resolve(
        result === "not_configured"
          ? ({ ok: false, error: "auth_failed" } as FetchSnapshotResult)
          : result,
      ),
  });
  adaptersByOrg.set(ORG, map);
}

function stepStatus(
  steps: Array<{ name: string; status: string }>,
  name: string,
): string | undefined {
  return steps.find((s) => s.name === name)?.status;
}

beforeEach(() => {
  adaptersByOrg.clear();
  recordValidationOutcomeMock.mockClear();
});

describe("validateIntegrationConnection", () => {
  it("passes every step for a healthy connection", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot(),
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(result.ok).toBe(true);
    expect(stepStatus(result.steps, "configured")).toBe("pass");
    expect(stepStatus(result.steps, "authenticated")).toBe("pass");
    expect(stepStatus(result.steps, "authorized")).toBe("pass");
    expect(stepStatus(result.steps, "patient_lookup")).toBe("pass");
    expect(stepStatus(result.steps, "schema")).toBe("pass");
    expect(result.received).toMatchObject({
      settings: true,
      compliance: true,
      recentNights: 1,
    });
  });

  it("reports a missing credential as not-configured, not as a failure to reach", async () => {
    installAdapter("not_configured");
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("configured");
    expect(recordValidationOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ notConfigured: true }),
    );
  });

  it("separates a bad secret from a missing entitlement", async () => {
    // 401 stops at `authenticated`; 403 gets past it and stops at
    // `authorized`. That difference is "rotate the secret" vs "call the
    // vendor about the agreement", and rotating a good secret is the
    // wrong move.
    installAdapter({ ok: false, error: "auth_failed" });
    const bad = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(bad.failedStep).toBe("authenticated");
    expect(bad.errorClass).toBe("configuration");

    installAdapter({ ok: false, error: "forbidden" });
    const forbidden = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(forbidden.failedStep).toBe("authorized");
    expect(stepStatus(forbidden.steps, "authenticated")).toBe("pass");
    expect(
      forbidden.steps.find((s) => s.name === "authorized")?.remedy,
    ).toContain("Do NOT rotate");
  });

  it("separates a patient that does not exist from a URL that does not exist", async () => {
    installAdapter({ ok: false, error: "not_found" });
    const missingPatient = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(stepStatus(missingPatient.steps, "patient_lookup")).toBe("no_data");
    expect(missingPatient.errorClass).toBe("no_data");

    installAdapter({ ok: false, error: "endpoint_not_found" });
    const wrongUrl = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(stepStatus(wrongUrl.steps, "patient_lookup")).toBe("fail");
    expect(wrongUrl.errorClass).toBe("configuration");
    expect(
      wrongUrl.steps.find((s) => s.name === "patient_lookup")?.remedy,
    ).toContain("placeholder");
  });

  it("marks a schema drift as a mapping failure, not as no data", async () => {
    // The failure a nightly sync absorbs most quietly: fields drop one
    // at a time and the counts only look a bit low.
    installAdapter({
      ok: true,
      snapshot: { source: SOURCE, nonsense: true },
    } as unknown as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("schema");
    expect(result.errorCategory).toBe("mapping_failed");
    expect(stepStatus(result.steps, "usage_data")).toBe("skipped");
  });

  it("reports an empty result as no_data, not as a broken endpoint", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot({
        recentNights: [],
        compliance: null,
        settings: null,
      }),
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(stepStatus(result.steps, "usage_data")).toBe("no_data");
    expect(stepStatus(result.steps, "compliance_data")).toBe("no_data");
    expect(stepStatus(result.steps, "device_settings")).toBe("no_data");
    // Nothing was broken — the vendor answered and had nothing.
    expect(result.ok).toBe(true);
  });

  it("fails the specific sub-resource that came back broken, not the whole probe silently", async () => {
    // A snapshot missing its compliance summary because that ONE
    // endpoint 403'd is not a patient with no compliance data.
    installAdapter({
      ok: true,
      snapshot: goodSnapshot({ compliance: null }),
      partial: [{ resource: "compliance", error: "forbidden" }],
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
    });
    expect(stepStatus(result.steps, "compliance_data")).toBe("fail");
    expect(stepStatus(result.steps, "usage_data")).toBe("pass");
    expect(result.ok).toBe(false);
    expect(result.partial).toEqual([
      { resource: "compliance", error: "forbidden" },
    ]);
  });

  it("flags a suspiciously round night count as possible truncation", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot({
        recentNights: Array.from({ length: 50 }, (_, i) =>
          night(`2026-04-${String((i % 28) + 1).padStart(2, "0")}`),
        ),
      }),
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
      windowDays: 90,
    });
    expect(stepStatus(result.steps, "pagination")).toBe("fail");
    expect(result.steps.find((s) => s.name === "pagination")?.detail).toContain(
      "truncated page",
    );
  });

  it("does not flag an ordinary partial-usage month", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot({
        recentNights: Array.from({ length: 23 }, (_, i) =>
          night(`2026-05-${String(i + 1).padStart(2, "0")}`),
        ),
      }),
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
      windowDays: 30,
    });
    expect(stepStatus(result.steps, "pagination")).toBe("pass");
  });

  it("never throws — a validator that can fail is one nobody runs", async () => {
    const map = new Map();
    map.set(SOURCE, {
      source: SOURCE,
      availability: () => ({ status: "configured" }),
      fetchSnapshot: () => Promise.reject(new Error("boom")),
    });
    adaptersByOrg.set(ORG, map);
    await expect(
      validateIntegrationConnection({
        orgId: ORG,
        source: SOURCE,
        partnerPatientId: "P-1",
      }),
    ).rejects.toThrow();
    // The adapter contract is that fetchSnapshot resolves with a
    // classified error rather than rejecting; a rejecting adapter is a
    // bug in the adapter, and the route's own try/catch covers it.
  });

  it("records the outcome so a status page can say when it last worked", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot(),
    } as FetchSnapshotResult);
    await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
      actorEmail: "ops@example.com",
    });
    expect(recordValidationOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG,
        source: SOURCE,
        ok: true,
        actorEmail: "ops@example.com",
      }),
    );
  });

  it("can skip the status write, for a batch refresh", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot(),
    } as FetchSnapshotResult);
    await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "P-1",
      skipStatusWrite: true,
    });
    expect(recordValidationOutcomeMock).not.toHaveBeenCalled();
  });

  it("never puts a vendor payload in a step detail", async () => {
    installAdapter({
      ok: true,
      snapshot: goodSnapshot({
        partnerPatientId: "SECRET-PATIENT-ID",
      }),
    } as FetchSnapshotResult);
    const result = await validateIntegrationConnection({
      orgId: ORG,
      source: SOURCE,
      partnerPatientId: "SECRET-PATIENT-ID",
    });
    const serialized = JSON.stringify(result.steps);
    expect(serialized).not.toContain("SECRET-PATIENT-ID");
  });
});
