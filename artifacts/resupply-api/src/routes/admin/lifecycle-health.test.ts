// Tests for GET /admin/lifecycle-health.
//
// The route changes nothing, so the only thing it can get wrong is what
// it SAYS — and there is one way to say it wrongly that matters: letting
// "we could not read it", "this tenant does not do that" and "nothing is
// configured" render as the same healthy zero as "we measured it and it
// is fine". These pin that the four stay four, all the way to the JSON.
//
// The second thing pinned is that a stored reading is visibly stored. The
// dead-letter signal cannot be measured from an HTTP request, so it comes
// from the last background scan; presenting a twelve-hour-old number as
// current is how an operator acts on a problem that was already fixed.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    /** Rows by table, for the live collectors. */
    tables: {} as Record<string, Array<Record<string, unknown>>>,
    /** Tables whose reads throw, simulating a partial outage. */
    failing: new Set<string>(),
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ): void => next();
  return {
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-cutover", () => ({
  CUTOVER_FLAG_KEYS: [
    "resupply.due_at_authoritative",
    "resupply.ship_evidence_required",
  ],
  readCutoverFlagState: async () => false,
  hasFreshReadyAssessment: async () => ({
    ok: false,
    state: "not_evaluated",
    record: null,
  }),
}));

vi.mock("@workspace/resupply-db", () => {
  function builder(table: string) {
    let rows = [...(state.tables[table] ?? [])];
    let headOnly = false;
    let wantCount = false;
    const settle = () =>
      state.failing.has(table)
        ? {
            data: null,
            count: null,
            error: { message: "relation unavailable" },
          }
        : {
            data: headOnly ? null : rows,
            count: wantCount ? rows.length : null,
            error: null,
          };
    const self: Record<string, unknown> = {
      select: (_c?: string, opts?: { count?: string; head?: boolean }) => {
        headOnly = opts?.head === true;
        wantCount = opts?.count === "exact";
        return self;
      },
      eq: (c: string, v: unknown) => {
        rows = rows.filter((r) => r[c] === v);
        return self;
      },
      gte: (c: string, v: string) => {
        rows = rows.filter((r) => String(r[c] ?? "") >= v);
        return self;
      },
      gt: () => self,
      lte: (c: string, v: string) => {
        rows = rows.filter((r) => r[c] != null && String(r[c]) <= v);
        return self;
      },
      lt: (c: string, v: string) => {
        rows = rows.filter((r) => r[c] != null && String(r[c]) < v);
        return self;
      },
      in: (c: string, vals: readonly unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[c]));
        return self;
      },
      is: (c: string, v: null) => {
        rows = rows.filter((r) => (r[c] ?? null) === v);
        return self;
      },
      not: (c: string) => {
        rows = rows.filter((r) => (r[c] ?? null) !== null);
        return self;
      },
      order: () => self,
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return Object.assign(Object.create(self), {
          maybeSingle: async () => {
            const s = settle();
            return { data: rows[0] ?? null, error: s.error };
          },
        });
      },
      range: (from: number, to: number) => {
        rows = rows.slice(from, to + 1);
        return Promise.resolve(settle());
      },
      maybeSingle: async () => {
        const s = settle();
        return { data: rows[0] ?? null, error: s.error };
      },
      then: (resolve: (v: unknown) => unknown) => resolve(settle()),
    };
    return self;
  }
  const client = {
    from: (table: string) => builder(table),
    raw: () => ({
      schema: () => ({
        from: (table: string) => builder(table),
        rpc: async () => ({ data: null, error: null }),
      }),
    }),
  };
  return {
    getOrgScopedClient: () => client,
    resolveSeedOrgId: async () => MOCK_ORG_ID,
    listActiveOrgIds: async () => [MOCK_ORG_ID],
  };
});

let app: Express;

interface SignalRow {
  key: string;
  status: string;
  value: number | null;
  display: string;
  reason: string | null;
  truncated: boolean;
  fromLastScan: boolean;
  lastScanAt: string | null;
  lastScanAgeHours: number | null;
  alertOpen: boolean;
  alertOpenHours: number | null;
  thresholdSource: string;
  warnEnv: string;
  failEnv: string;
}
interface Body {
  signals: SignalRow[];
  refreshedAt: string;
  lastScanAt: string | null;
  lastScanAgeHours: number | null;
  totals: Record<string, number>;
  scope: { kind: string; platformSignalsElsewhere: string[] };
}

const row = (b: Body, key: string) => b.signals.find((s) => s.key === key)!;

beforeEach(async () => {
  vi.resetModules();
  state.tables = {
    episodes: [],
    prescriptions: [],
    fulfillments: [],
    insurance_claims: [],
    integration_connector_status: [],
    integration_reconciliation_runs: [],
    pacware_shipment_imports: [],
    lifecycle_health_observations: [],
    lifecycle_health_alerts: [],
    feature_flags: [],
  };
  state.failing = new Set();
  mockAdmin.current = {
    userId: "u-1",
    email: "ops@example.com",
    role: "admin",
    orgId: MOCK_ORG_ID,
  };
  const router = (await import("./lifecycle-health")).default;
  app = express();
  app.use(express.json());
  app.use(router);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN;
});

async function get(): Promise<Body> {
  const res = await request(app).get("/admin/lifecycle-health");
  expect(res.status).toBe(200);
  return res.body as Body;
}

describe("shape", () => {
  it("returns every tenant-scoped signal", async () => {
    const body = await get();
    expect(body.signals.length).toBeGreaterThan(20);
    expect(body.totals.signalCount).toBe(body.signals.length);
  });

  it("names the platform-scope signals it deliberately does NOT include", async () => {
    // They are about rows that belong to no tenant. Repeating the same
    // global number inside every practice's panel would have each
    // operator chasing another's problem — but silently omitting them
    // would make the catalog look incomplete.
    const body = await get();
    expect(body.scope.platformSignalsElsewhere.sort()).toEqual([
      "inbound_attribution_failures",
      "voice_calls_unattributed",
    ]);
    expect(body.signals.some((s) => s.key === "voice_calls_unattributed")).toBe(
      false,
    );
  });

  it("stamps the reading with a time and forbids caching", async () => {
    const res = await request(app).get("/admin/lifecycle-health");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Date.parse((res.body as Body).refreshedAt)).not.toBeNaN();
  });

  it("fails closed without tenant context", async () => {
    mockAdmin.current = {
      userId: "u-1",
      email: "ops@example.com",
      role: "admin",
      orgId: null,
    };
    const res = await request(app).get("/admin/lifecycle-health");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "tenant_context_missing" });
  });
});

describe("the four non-alerting answers stay four", () => {
  it("reports `disabled` distinctly, with a value of null", async () => {
    // No active prescriptions: nothing to measure and nothing wrong.
    const body = await get();
    const stalled = row(body, "cycle_creation_stalled");
    expect(stalled.status).toBe("disabled");
    expect(stalled.value).toBeNull();
    expect(stalled.display).toBe("—");
  });

  it("reports `not_configured` distinctly from disabled", async () => {
    const body = await get();
    expect(row(body, "connector_failures").status).toBe("not_configured");
    expect(row(body, "pacware_unmatched_rows").status).toBe("not_configured");
  });

  it("reports `unknown` for a failed read, never zero", async () => {
    state.failing.add("insurance_claims");
    const body = await get();
    const stuck = row(body, "claims_stuck_submitting");
    expect(stuck.status).toBe("unknown");
    expect(stuck.value).toBeNull();
    expect(body.totals.unknown).toBeGreaterThan(0);
  });

  it("counts the four separately in the totals", async () => {
    // Folding any of these into `ok` is the single change that would
    // make the panel lie.
    const body = await get();
    expect(body.totals).toHaveProperty("ok");
    expect(body.totals).toHaveProperty("disabled");
    expect(body.totals).toHaveProperty("notConfigured");
    expect(body.totals).toHaveProperty("unknown");
    const sum =
      body.totals.ok +
      body.totals.warning +
      body.totals.failure +
      body.totals.disabled +
      body.totals.notConfigured +
      body.totals.unknown;
    expect(sum).toBe(body.signals.length);
  });
});

describe("thresholds are visible and tunable", () => {
  it("reports the default source when nothing is configured", async () => {
    const body = await get();
    expect(row(body, "shipped_unbilled").thresholdSource).toBe("default");
  });

  it("reports `env` and the new value when one is set", async () => {
    process.env.LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN = "2";
    const body = await get();
    const r = row(body, "shipped_unbilled");
    expect(r.thresholdSource).toBe("env");
    expect((r as unknown as { warnThreshold: number }).warnThreshold).toBe(2);
  });

  it("names the variables, so tuning does not require reading the source", async () => {
    const body = await get();
    expect(row(body, "shipped_unbilled").warnEnv).toBe(
      "LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN",
    );
    expect(row(body, "shipped_unbilled").failEnv).toBe(
      "LIFECYCLE_HEALTH_SHIPPED_UNBILLED_FAIL",
    );
  });

  it("says so when a configured value did not take", async () => {
    // Identical to a default from every other angle, which is exactly
    // why it needs its own word.
    process.env.LIFECYCLE_HEALTH_SHIPPED_UNBILLED_WARN = "twelve";
    const body = await get();
    expect(row(body, "shipped_unbilled").thresholdSource).toBe(
      "default_after_invalid_env",
    );
  });
});

describe("a stored reading is visibly stored", () => {
  it("marks the worker-only signal and reports its age", async () => {
    const observedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    state.tables.lifecycle_health_observations = [
      {
        scope_id: MOCK_ORG_ID,
        signal_key: "worker_failures",
        status: "warning",
        observed_value: 4,
        sample_size: null,
        detail: {},
        observed_at: observedAt,
      },
    ];
    const body = await get();
    const worker = row(body, "worker_failures");
    expect(worker.fromLastScan).toBe(true);
    expect(worker.value).toBe(4);
    expect(worker.lastScanAgeHours).toBeCloseTo(3, 0);
    expect(body.lastScanAgeHours).toBeCloseTo(3, 0);
  });

  it("reports the worker signal as unknown when no scan has ever run", async () => {
    // Not zero. "The monitor has not reported" and "there are no dead
    // jobs" are different, and only one of them is good news.
    const body = await get();
    const worker = row(body, "worker_failures");
    expect(worker.status).toBe("unknown");
    expect(worker.reason).toMatch(/has not reported yet/i);
    expect(body.lastScanAt).toBeNull();
  });

  it("does not mark a live signal as coming from a scan", async () => {
    const body = await get();
    expect(row(body, "shipped_unbilled").fromLastScan).toBe(false);
  });

  it("still renders when the snapshot table is unreadable", async () => {
    // Supporting detail, not the panel. A failed snapshot read must not
    // blank live readings.
    state.failing.add("lifecycle_health_observations");
    const body = await get();
    expect(body.signals.length).toBeGreaterThan(20);
    expect(row(body, "worker_failures").status).toBe("unknown");
  });
});

describe("open alerts are surfaced alongside the live reading", () => {
  it("reports that an alert is open and how long it has been", async () => {
    state.tables.lifecycle_health_alerts = [
      {
        scope_id: MOCK_ORG_ID,
        signal_key: "shipped_unbilled",
        status: "failure",
        peak_status: "failure",
        first_observed_at: new Date(
          Date.now() - 48 * 60 * 60 * 1000,
        ).toISOString(),
        last_notified_at: new Date().toISOString(),
        notify_count: 2,
        resolved_at: null,
      },
    ];
    const body = await get();
    const r = row(body, "shipped_unbilled");
    expect(r.alertOpen).toBe(true);
    expect(r.alertOpenHours).toBeCloseTo(48, 0);
    expect(body.totals.openAlerts).toBe(1);
  });

  it("still renders when the alert table is unreadable", async () => {
    state.failing.add("lifecycle_health_alerts");
    const body = await get();
    expect(body.signals.length).toBeGreaterThan(20);
    expect(body.totals.openAlerts).toBe(0);
  });
});

describe("ordering", () => {
  it("puts what is wrong first", async () => {
    // An operator opening this page while something is on fire should
    // not have to scroll past twenty green rows.
    state.tables.fulfillments = Array.from({ length: 80 }, (_, i) => ({
      id: `f${i}`,
      shipped_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      status: "queued",
      created_at: new Date(Date.now() - 25 * 86_400_000).toISOString(),
    }));
    const body = await get();
    expect(body.signals[0].status).toBe("failure");
    expect(body.signals[0].key).toBe("shipped_unbilled");
  });
});
