// The nightly sync's behaviour when the vendor misbehaves: bounded
// retries, a circuit breaker, and what a half-answered snapshot is
// recorded as.
//
// The sibling spec pins the SCAN's shape by reading the source. This one
// is behavioural, because the questions it answers are counts: how many
// times did we call a vendor that is refusing every request, and what did
// the connector status say afterwards. Those are exactly the numbers that
// decide whether an outage costs us a support ticket or an account
// lockout, and no structural check can answer them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FetchSnapshotResult,
  IntegrationSource,
} from "@workspace/resupply-integrations";

const ORG = "11111111-1111-4111-8111-111111111111";

interface LinkRow {
  id: string;
  patient_id: string;
  source: string;
  partner_patient_id: string;
  status: string;
}

const { db, adapterState } = vi.hoisted(() => ({
  db: {
    links: [] as LinkRow[],
    writes: [] as Array<{
      table: string;
      op: string;
      payload: Record<string, unknown>;
    }>,
  },
  adapterState: {
    calls: 0,
    /** Answers, consumed in order; the last one repeats. */
    results: [] as unknown[],
  },
}));

vi.mock("@workspace/resupply-db", () => {
  const client = {
    from: (table: string) => {
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        in: () => self,
        order: () => self,
        limit: () => self,
        update: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "update", payload });
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
        upsert: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "upsert", payload });
          return Promise.resolve({ data: null, error: null });
        },
        insert: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "insert", payload });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: table === "patient_therapy_links" ? db.links : [],
            error: null,
          }),
      };
      return self;
    },
  };
  return {
    getOrgScopedClient: () => client,
    getSupabaseServiceRoleClient: () => client,
  };
});

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(() => Promise.resolve()),
}));

const recordSyncOutcomeMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../lib/integrations/connector-status.js", () => ({
  recordSyncOutcome: recordSyncOutcomeMock,
}));

vi.mock("../../lib/integrations/persist-nights.js", () => ({
  persistTherapyNights: () => Promise.resolve({ inserted: 0 }),
}));

vi.mock("../lib/integration-health.js", () => ({
  recordIntegrationSuccess: () => Promise.resolve(),
  recordIntegrationFailure: () => Promise.resolve(),
}));

const SOURCE = "resmed_airview" as IntegrationSource;

vi.mock("../../lib/integrations/registry.js", () => ({
  getIntegrationAdaptersForOrg: () =>
    Promise.resolve(
      new Map([
        [
          SOURCE,
          {
            source: SOURCE,
            availability: () => ({ status: "configured" as const }),
            fetchSnapshot: () => {
              const i = Math.min(
                adapterState.calls,
                adapterState.results.length - 1,
              );
              adapterState.calls += 1;
              return Promise.resolve(
                adapterState.results[i] as FetchSnapshotResult,
              );
            },
          },
        ],
      ]),
    ),
}));

const { runTherapyNightlySyncForOrg, resetTherapySyncBreaker } =
  await import("./therapy-integrations-nightly-sync");

function makeLinks(n: number): LinkRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `link-${i}`,
    patient_id: `pat-${i}`,
    source: SOURCE,
    partner_patient_id: `pp-${i}`,
    status: "active",
  }));
}

function okSnapshot(
  partial?: Array<{ resource: string; error: string }>,
): FetchSnapshotResult {
  return {
    ok: true,
    snapshot: {
      source: SOURCE,
      partnerPatientId: "pp-0",
      settings: {
        deviceModel: "AirSense 11",
        deviceSerial: null,
        therapyMode: null,
        pressureMinCmh2o: null,
        pressureMaxCmh2o: null,
        rampMinutes: null,
        humidifierLevel: null,
        maskType: null,
      },
      compliance: null,
      recentNights: [
        {
          nightDate: "2026-06-01",
          usageMinutes: 400,
          ahi: 2,
          leakRateLMin: 4,
          pressureP95Cmh2o: null,
        },
      ],
      supplies: [],
    },
    ...(partial ? { partial } : {}),
  } as unknown as FetchSnapshotResult;
}

beforeEach(() => {
  db.links = [];
  db.writes = [];
  adapterState.calls = 0;
  adapterState.results = [];
  recordSyncOutcomeMock.mockClear();
  resetTherapySyncBreaker();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run the job with fake timers, draining the retry backoff sleeps. */
async function run(): Promise<
  Awaited<ReturnType<typeof runTherapyNightlySyncForOrg>>
> {
  const promise = runTherapyNightlySyncForOrg(ORG);
  // The job sleeps between links (throttle) and between retry attempts.
  // Advance until it settles rather than waiting out ~200ms per link.
  for (let i = 0; i < 400; i++) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return promise;
}

describe("bounded retries", () => {
  it("retries a TRANSIENT failure and reports the recovery as a success", async () => {
    db.links = makeLinks(1);
    adapterState.results = [{ ok: false, error: "server_error" }, okSnapshot()];
    const result = await run();
    expect(adapterState.calls).toBe(2);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.retriedLinks).toBe(1);
  });

  it("does NOT retry a CONFIGURATION failure — one bad secret, one call", async () => {
    // This is the whole asymmetry. Retrying `auth_failed` across a
    // thousand links is how an account gets locked out by the vendor.
    db.links = makeLinks(1);
    adapterState.results = [{ ok: false, error: "auth_failed" }];
    const result = await run();
    expect(adapterState.calls).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.retriedLinks).toBe(0);
  });

  it("gives up after the attempt bound rather than retrying forever", async () => {
    db.links = makeLinks(1);
    adapterState.results = [{ ok: false, error: "timeout" }];
    await run();
    expect(adapterState.calls).toBe(2);
  });
});

describe("circuit breaker", () => {
  it("stops calling a vendor that is down, instead of hammering it once per patient", async () => {
    // 20 links, a vendor refusing everything. Without the breaker this is
    // 20 links x 2 attempts = 40 calls. With it, the breaker opens after
    // 5 consecutive failures and the rest are skipped without a call.
    db.links = makeLinks(20);
    adapterState.results = [{ ok: false, error: "server_error" }];
    const result = await run();
    expect(adapterState.calls).toBe(10); // 5 failing links x 2 attempts
    expect(result.breakerSkipped).toBe(15);
    expect(result.failed).toBe(20);
    expect(result.scanned).toBe(20);
  });

  it("carries the error that opened it, so the connector names the vendor problem", async () => {
    db.links = makeLinks(20);
    adapterState.results = [{ ok: false, error: "server_error" }];
    await run();
    expect(recordSyncOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: SOURCE,
        ok: false,
        errorCategory: "server_error",
      }),
    );
  });

  it("stamps a breaker-skipped link so it rotates instead of starving the queue", async () => {
    db.links = makeLinks(20);
    adapterState.results = [{ ok: false, error: "server_error" }];
    await run();
    const stamps = db.writes.filter(
      (w) =>
        w.table === "patient_therapy_links" &&
        w.payload.last_sync_status === "breaker_open",
    );
    expect(stamps).toHaveLength(15);
    for (const s of stamps) {
      expect(s.payload.last_synced_at).toBeTruthy();
    }
  });

  it("does NOT trip on `no_data` — an empty roster is not an outage", async () => {
    db.links = makeLinks(20);
    adapterState.results = [{ ok: false, error: "no_data" }];
    const result = await run();
    // Every link is still called: no_data records as a breaker success.
    expect(adapterState.calls).toBe(20);
    expect(result.breakerSkipped).toBe(0);
  });
});

describe("a half-answered snapshot", () => {
  it("records the adapter's REPORTED partial, with the sub-resource and reason", async () => {
    db.links = makeLinks(1);
    adapterState.results = [
      okSnapshot([{ resource: "compliance", error: "forbidden" }]),
    ];
    const result = await run();
    const snap = db.writes.find(
      (w) => w.table === "patient_integration_snapshots",
    );
    expect(snap?.payload.fetch_status).toBe("partial");
    expect(snap?.payload.fetch_error).toBe("compliance=forbidden");
    // The patient DID get a snapshot.
    expect(result.refreshed).toBe(1);
    // …but the connector is not allowed to report a spotless run.
    expect(recordSyncOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, errorCategory: "forbidden" }),
    );
  });

  it("keeps the link's own status in agreement with the snapshot's", async () => {
    db.links = makeLinks(1);
    adapterState.results = [
      okSnapshot([{ resource: "nights", error: "endpoint_not_found" }]),
    ];
    await run();
    const stamp = db.writes.find(
      (w) =>
        w.table === "patient_therapy_links" &&
        w.payload.last_sync_status !== undefined,
    );
    expect(stamp?.payload.last_sync_status).toBe("partial");
    expect(stamp?.payload.last_sync_error).toBe("nights=endpoint_not_found");
  });

  it("still reports a whole snapshot as ok", async () => {
    db.links = makeLinks(1);
    adapterState.results = [okSnapshot()];
    await run();
    const snap = db.writes.find(
      (w) => w.table === "patient_integration_snapshots",
    );
    expect(snap?.payload.fetch_status).toBe("ok");
    expect(snap?.payload.fetch_error).toBeNull();
    expect(recordSyncOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    );
  });
});
