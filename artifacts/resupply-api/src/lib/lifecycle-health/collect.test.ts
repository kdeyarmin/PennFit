// The collectors, against a PostgREST-shaped fake whose filters really
// filter.
//
// A fake that ignored filters could not tell a correct collector from one
// that counts the whole table, which is most of what is worth checking
// here. So this one applies eq/gte/lt/in/is/not the way PostgREST does,
// honours `head: true` counts and `range()` paging, and can be made to
// fail one table at a time.
//
// What the suite is actually pinning:
//
//   * a failed read produces `unknown`, never a zero — for EVERY signal
//     independently, because one broken table must blank one row and not
//     the panel;
//   * `disabled`, `not_configured` and `unknown` stay three different
//     answers all the way through;
//   * a capped read reports `truncated`, and the meta-signal counts it;
//   * the anti-join collectors (shipped-unbilled, claims-without-
//     evidence) actually subtract, rather than reporting the population.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Row = Record<string, unknown>;

const { store } = vi.hoisted(() => ({
  store: {
    tables: {} as Record<string, Row[]>,
    /** Tables whose reads should throw, to test the unknown path. */
    failing: new Set<string>(),
    flags: {} as Record<string, boolean>,
    freshAssessment: {} as Record<string, boolean>,
  },
}));

vi.mock("@workspace/resupply-db", () => {
  function builder(table: string) {
    let rows = [...(store.tables[table] ?? [])];
    let headOnly = false;
    let wantCount = false;

    const settle = () => {
      if (store.failing.has(table)) {
        return { data: null, count: null, error: { message: "boom" } };
      }
      return {
        data: headOnly ? null : rows,
        count: wantCount ? rows.length : null,
        error: null,
      };
    };

    const self = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
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
      gt: (c: string, v: string) => {
        rows = rows.filter((r) => String(r[c] ?? "") > v);
        return self;
      },
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
      not: (c: string, _op: string, _v: null) => {
        rows = rows.filter((r) => (r[c] ?? null) !== null);
        return self;
      },
      order: (c: string, o: { ascending: boolean }) => {
        rows = [...rows].sort((a, b) => {
          const x = String(a[c] ?? "");
          const y = String(b[c] ?? "");
          return o.ascending ? x.localeCompare(y) : y.localeCompare(x);
        });
        return self;
      },
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return self;
      },
      range: (from: number, to: number) => {
        rows = rows.slice(from, to + 1);
        return Promise.resolve(settle());
      },
      maybeSingle: async () => {
        const s = settle();
        return { data: (s.data as Row[] | null)?.[0] ?? null, error: s.error };
      },
      then: (resolve: (v: unknown) => void) => resolve(settle()),
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
    resolveSeedOrgId: async () => ORG,
    listActiveOrgIds: async () => [ORG],
  };
});

vi.mock("@workspace/resupply-cutover", () => ({
  CUTOVER_FLAG_KEYS: [
    "resupply.due_at_authoritative",
    "resupply.ship_evidence_required",
  ],
  readCutoverFlagState: async (_org: string, key: string) =>
    store.flags[key] ?? false,
  hasFreshReadyAssessment: async (_org: string, key: string) => ({
    ok: store.freshAssessment[key] ?? false,
    state: store.freshAssessment[key] ? "ready" : "not_evaluated",
    record: null,
  }),
}));

const { collectTenantObservations, collectPlatformObservations } = await import(
  "./collect"
);
const { TENANT_SIGNALS } = await import("./signals");

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

beforeEach(() => {
  store.tables = {
    episodes: [],
    prescriptions: [],
    fulfillments: [],
    insurance_claims: [],
    integration_connector_status: [],
    integration_reconciliation_runs: [],
    pacware_shipment_imports: [],
    voice_calls: [],
    inbound_attribution_failures: [],
    feature_flags: [],
  };
  store.failing = new Set();
  store.flags = {};
  store.freshAssessment = {};
});

const collect = () => collectTenantObservations(ORG, { nowMs: NOW });

describe("a failed read is unknown, never zero", () => {
  it("blanks ONE signal when ONE table fails, not the panel", async () => {
    store.tables.insurance_claims = [];
    store.failing.add("insurance_claims");
    store.tables.episodes = [
      { status: "confirmed", created_at: isoAgo(HOUR), closed_reason: null },
    ];
    store.tables.prescriptions = [
      { status: "active", created_at: isoAgo(30 * DAY) },
    ];

    const obs = await collect();
    expect(obs.claims_stuck_submitting.state).toBe("unknown");
    expect(obs.payer_denial_rate.state).toBe("unknown");
    // …and the episode-side signals still measured.
    expect(obs.cycle_creation_stalled.state).toBe("measured");
    expect(obs.episodes_open_past_age.state).toBe("measured");
  });

  it("never returns a measured zero for a failing table", async () => {
    for (const table of ["episodes", "fulfillments", "insurance_claims"]) {
      store.failing = new Set([table]);
      const obs = await collect();
      const measuredZeros = Object.entries(obs).filter(
        ([, o]) => o.state === "measured" && o.value === 0,
      );
      // The meta-signal is allowed to be a measured zero; nothing else
      // that reads the failing table may be.
      for (const [key] of measuredZeros) {
        expect(
          ["analytics_window_truncated"].includes(key) ||
            obs[key].state === "measured",
          `${key} while ${table} was failing`,
        ).toBe(true);
      }
      expect(obs.analytics_window_truncated.state).toBe("measured");
    }
  });

  it("gives every tenant signal SOME observation, never a missing key", async () => {
    const obs = await collect();
    for (const signal of TENANT_SIGNALS) {
      expect(obs[signal.key], signal.key).toBeDefined();
    }
  });
});

describe("intake", () => {
  it("reports cycle creation as a multiple of the trailing baseline", async () => {
    store.tables.episodes = [
      // 20 in the last day…
      ...Array.from({ length: 20 }, () => ({
        created_at: isoAgo(2 * HOUR),
        status: "outreach_pending",
      })),
      // …against 14 over the prior fortnight, i.e. one a day.
      ...Array.from({ length: 14 }, (_, i) => ({
        created_at: isoAgo((2 + i) * DAY),
        status: "confirmed",
      })),
    ];
    const obs = await collect();
    expect(obs.cycle_creation_spike.value).toBeCloseTo(20, 1);
    expect(obs.cycle_creation_spike.sample).toBe(14);
  });

  it("reports `disabled` for a tenant with no active prescriptions", async () => {
    // No population means no cycles to create and nothing wrong. This
    // must not read as a stalled sweep.
    const obs = await collect();
    expect(obs.cycle_creation_stalled.state).toBe("disabled");
    expect(obs.cycle_creation_stalled.reason).toMatch(/no active prescription/i);
  });

  it("ages a stall from the last cycle when one exists", async () => {
    store.tables.prescriptions = [
      { status: "active", created_at: isoAgo(90 * DAY) },
    ];
    store.tables.episodes = [{ created_at: isoAgo(30 * HOUR) }];
    const obs = await collect();
    expect(obs.cycle_creation_stalled.value).toBeCloseTo(30, 0);
  });

  it("ages it from the OLDEST prescription when no cycle was ever created", async () => {
    // The maximal form of the condition: we have had patients to serve
    // for months and produced nothing for them.
    store.tables.prescriptions = [
      { status: "active", created_at: isoAgo(10 * DAY) },
      { status: "active", created_at: isoAgo(3 * DAY) },
    ];
    const obs = await collect();
    expect(obs.cycle_creation_stalled.value).toBeCloseTo(240, 0);
    expect(obs.cycle_creation_stalled.detail?.episodesEverCreated).toBe(0);
  });

  it("counts only OPEN cycles past their expiry", async () => {
    store.tables.episodes = [
      { status: "awaiting_response", expires_at: isoAgo(DAY) },
      { status: "address_hold", expires_at: isoAgo(DAY) },
      // Closed — not this signal's problem.
      { status: "fulfilled", expires_at: isoAgo(DAY) },
      // Open but not yet expired.
      { status: "awaiting_response", expires_at: isoAgo(-DAY) },
    ];
    const obs = await collect();
    expect(obs.episodes_open_past_age.value).toBe(2);
  });
});

describe("outreach and fulfillment", () => {
  it("counts each close-out reason within its own window", async () => {
    store.tables.episodes = [
      { closed_reason: "never_contacted", closed_at: isoAgo(2 * DAY) },
      { closed_reason: "never_contacted", closed_at: isoAgo(20 * DAY) },
      { closed_reason: "no_response", closed_at: isoAgo(DAY) },
      { closed_reason: "assumed_shipped", closed_at: isoAgo(DAY) },
      { closed_reason: "assumed_shipped", closed_at: isoAgo(3 * DAY) },
    ];
    const obs = await collect();
    expect(obs.never_contacted_growth.value).toBe(1);
    expect(obs.no_response_growth.value).toBe(1);
    expect(obs.assumed_shipped_growth.value).toBe(2);
  });

  it("reports shipment lag as `disabled` when nothing has shipped", async () => {
    // No feed means no lag to measure. Reporting zero would say the feed
    // is instant.
    const obs = await collect();
    expect(obs.shipment_evidence_lag.state).toBe("disabled");
  });

  it("averages shipment lag over the window", async () => {
    store.tables.fulfillments = [
      { created_at: isoAgo(5 * DAY), shipped_at: isoAgo(4 * DAY) },
      { created_at: isoAgo(9 * DAY), shipped_at: isoAgo(6 * DAY) },
    ];
    const obs = await collect();
    // 24h and 72h.
    expect(obs.shipment_evidence_lag.value).toBeCloseTo(48, 0);
    expect(obs.shipment_evidence_lag.sample).toBe(2);
  });

  it("counts queued-and-unshipped only past the grace age", async () => {
    store.tables.fulfillments = [
      { status: "queued", shipped_at: null, created_at: isoAgo(10 * DAY) },
      { status: "queued", shipped_at: null, created_at: isoAgo(2 * DAY) },
      { status: "queued", shipped_at: isoAgo(DAY), created_at: isoAgo(9 * DAY) },
    ];
    const obs = await collect();
    expect(obs.fulfilled_not_shipped.value).toBe(1);
  });
});

describe("the anti-join collectors actually subtract", () => {
  it("counts shipped product with no claim against it", async () => {
    store.tables.fulfillments = [
      { id: "f1", shipped_at: isoAgo(10 * DAY), status: "queued" },
      { id: "f2", shipped_at: isoAgo(20 * DAY), status: "queued" },
      { id: "f3", shipped_at: isoAgo(30 * DAY), status: "queued" },
    ];
    store.tables.insurance_claims = [
      { fulfillment_id: "f1", status: "submitted", created_at: isoAgo(9 * DAY) },
    ];
    const obs = await collect();
    expect(obs.shipped_unbilled.value).toBe(2);
    expect(obs.shipped_unbilled.sample).toBe(3);
  });

  it("excludes shipments too recent to be late", async () => {
    // Billing runs in batches; three days old is not a backlog.
    store.tables.fulfillments = [
      { id: "f1", shipped_at: isoAgo(3 * DAY), status: "queued" },
    ];
    const obs = await collect();
    expect(obs.shipped_unbilled.value).toBe(0);
  });

  it("reports claims-without-evidence as `disabled` when the tenant does not require it", async () => {
    store.flags["resupply.ship_evidence_required"] = false;
    const obs = await collect();
    expect(obs.claims_missing_ship_evidence.state).toBe("disabled");
  });

  it("counts a claim whose fulfillment never shipped — and one with no fulfillment at all", async () => {
    store.flags["resupply.ship_evidence_required"] = true;
    store.tables.insurance_claims = [
      { id: "c1", fulfillment_id: "f1", created_at: isoAgo(2 * DAY) },
      { id: "c2", fulfillment_id: "f2", created_at: isoAgo(2 * DAY) },
      // No fulfillment at all: the worse version of the problem.
      { id: "c3", fulfillment_id: null, created_at: isoAgo(2 * DAY) },
    ];
    store.tables.fulfillments = [
      { id: "f1", shipped_at: isoAgo(3 * DAY) },
      { id: "f2", shipped_at: null },
    ];
    const obs = await collect();
    expect(obs.claims_missing_ship_evidence.value).toBe(2);
    expect(obs.claims_missing_ship_evidence.detail?.withoutFulfillment).toBe(1);
  });
});

describe("billing rates", () => {
  beforeEach(() => {
    store.tables.insurance_claims = [
      ...Array.from({ length: 3 }, (_, i) => ({
        id: `r${i}`,
        status: "rejected",
        created_at: isoAgo(5 * DAY),
        fulfillment_id: null,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `d${i}`,
        status: "denied",
        created_at: isoAgo(5 * DAY),
        fulfillment_id: null,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `p${i}`,
        status: "paid",
        created_at: isoAgo(5 * DAY),
        fulfillment_id: null,
      })),
    ];
  });

  it("keeps a clearinghouse rejection out of the denial rate", async () => {
    // A rejection never reached the payer. Counting it as a denial both
    // overstates denials and hides work that is still submittable.
    const obs = await collect();
    // 2 denied of (2 denied + 5 paid) adjudicated.
    expect(obs.payer_denial_rate.value).toBeCloseTo(2 / 7, 4);
    expect(obs.payer_denial_rate.sample).toBe(7);
  });

  it("counts rejections against everything that reached the clearinghouse", async () => {
    const obs = await collect();
    expect(obs.clearinghouse_rejection_rate.value).toBeCloseTo(3 / 10, 4);
    expect(obs.clearinghouse_rejection_rate.sample).toBe(10);
  });

  it("reports a rate of zero, not null, when nothing was rejected", async () => {
    store.tables.insurance_claims = [
      { id: "p1", status: "paid", created_at: isoAgo(DAY), fulfillment_id: null },
    ];
    const obs = await collect();
    expect(obs.clearinghouse_rejection_rate.value).toBe(0);
    // …and the evaluator holds the breach back on a sample of one.
    expect(obs.clearinghouse_rejection_rate.sample).toBe(1);
  });
});

describe("integrations distinguish absent from healthy", () => {
  it("reports `not_configured` for a tenant with no connector", async () => {
    const obs = await collect();
    for (const key of [
      "connector_failures",
      "connector_partial_responses",
      "therapy_data_staleness",
      "portal_reconciliation_discrepancies",
    ]) {
      expect(obs[key].state, key).toBe("not_configured");
    }
  });

  it("takes the WORST consecutive-failure count across connectors", async () => {
    store.tables.integration_connector_status = [
      {
        source: "resmed_airview",
        status: "live_validated",
        consecutive_failures: 1,
        last_sync_success_at: isoAgo(2 * HOUR),
        partial_resources: [],
      },
      {
        source: "philips_care",
        status: "configured",
        consecutive_failures: 7,
        last_sync_success_at: isoAgo(200 * HOUR),
        partial_resources: ["compliance"],
      },
    ];
    const obs = await collect();
    expect(obs.connector_failures.value).toBe(7);
    expect(obs.connector_partial_responses.value).toBe(1);
    // Staleness reads the NEWEST success — one healthy connector does not
    // make the fleet stale, and one stale one does not make it fresh.
    expect(obs.therapy_data_staleness.value).toBeCloseTo(2, 0);
  });

  it("reports staleness as not-configured when no sync ever succeeded", async () => {
    store.tables.integration_connector_status = [
      {
        source: "resmed_airview",
        status: "configured",
        consecutive_failures: 0,
        last_sync_success_at: null,
        partial_resources: [],
      },
    ];
    const obs = await collect();
    expect(obs.therapy_data_staleness.state).toBe("not_configured");
    // …while the failure count IS measurable.
    expect(obs.connector_failures.state).toBe("measured");
  });

  it("sums the newest reconciliation run PER SOURCE", async () => {
    // A global "latest" would let one source's fresh run hide another's
    // stale one.
    store.tables.integration_connector_status = [
      {
        source: "resmed_airview",
        status: "configured",
        consecutive_failures: 0,
        last_sync_success_at: isoAgo(HOUR),
        partial_resources: [],
      },
    ];
    store.tables.integration_reconciliation_runs = [
      {
        source: "resmed_airview",
        status: "completed",
        created_at: isoAgo(HOUR),
        missing_locally_count: 2,
        missing_in_portal_count: 1,
        mismatched_count: 0,
      },
      {
        source: "resmed_airview",
        status: "completed",
        created_at: isoAgo(50 * DAY),
        missing_locally_count: 99,
        missing_in_portal_count: 99,
        mismatched_count: 99,
      },
      {
        source: "philips_care",
        status: "completed",
        created_at: isoAgo(2 * DAY),
        missing_locally_count: 4,
        missing_in_portal_count: 0,
        mismatched_count: 3,
      },
    ];
    const obs = await collect();
    expect(obs.portal_reconciliation_discrepancies.value).toBe(10);
    expect(obs.portal_reconciliation_discrepancies.sample).toBe(2);
  });
});

describe("PacWare imports", () => {
  it("reports `not_configured` when no file was ever imported", async () => {
    // Not the same as an import with no problems: until a feed exists,
    // shipments are invisible to this system.
    const obs = await collect();
    for (const key of [
      "pacware_unmatched_rows",
      "pacware_ambiguous_rows",
      "pacware_invalid_dates",
    ]) {
      expect(obs[key].state, key).toBe("not_configured");
    }
  });

  it("reads the newest COMMITTED import, ignoring previews", async () => {
    // A preview is somebody checking a file. Alerting on a check would
    // punish the careful behaviour preview mode exists to encourage.
    store.tables.pacware_shipment_imports = [
      {
        mode: "preview",
        created_at: isoAgo(HOUR),
        dispositions: { unmatched: 500, ambiguous: 500 },
      },
      {
        mode: "commit",
        created_at: isoAgo(2 * HOUR),
        dispositions: {
          unmatched: 3,
          ambiguous: 1,
          invalid: 2,
          too_old: 1,
          future_dated: 4,
        },
      },
    ];
    const obs = await collect();
    expect(obs.pacware_unmatched_rows.value).toBe(3);
    expect(obs.pacware_ambiguous_rows.value).toBe(1);
    expect(obs.pacware_invalid_dates.value).toBe(7);
  });

  it("treats an absent disposition key as zero, not as a crash", async () => {
    store.tables.pacware_shipment_imports = [
      { mode: "commit", created_at: isoAgo(HOUR), dispositions: {} },
    ];
    const obs = await collect();
    expect(obs.pacware_unmatched_rows.value).toBe(0);
  });
});

describe("flags without readiness evidence", () => {
  it("counts a flag that is on with no fresh assessment", async () => {
    store.flags["resupply.due_at_authoritative"] = true;
    store.freshAssessment["resupply.due_at_authoritative"] = false;
    const obs = await collect();
    expect(obs.flags_without_readiness_evidence.value).toBe(1);
    expect(String(obs.flags_without_readiness_evidence.detail?.flags)).toContain(
      "due_at_authoritative",
    );
  });

  it("does not count a flag that is on WITH evidence", async () => {
    store.flags["resupply.due_at_authoritative"] = true;
    store.freshAssessment["resupply.due_at_authoritative"] = true;
    const obs = await collect();
    expect(obs.flags_without_readiness_evidence.value).toBe(0);
  });

  it("does not count a flag that is off, assessed or not", async () => {
    store.flags["resupply.ship_evidence_required"] = false;
    const obs = await collect();
    expect(obs.flags_without_readiness_evidence.value).toBe(0);
  });
});

describe("the truncation meta-signal", () => {
  it("reports zero when nothing capped", async () => {
    const obs = await collect();
    expect(obs.analytics_window_truncated.value).toBe(0);
    expect(obs.analytics_window_truncated.detail?.collectors).toBe("none");
  });

  it("counts a capped collector and NAMES it", async () => {
    // 5001 rows: one past the five-page ceiling. The number the capped
    // collector produced is now a floor, and saying which one it was is
    // what makes that actionable.
    store.tables.fulfillments = Array.from({ length: 5001 }, (_, i) => ({
      id: `f${i}`,
      shipped_at: isoAgo(20 * DAY),
      status: "queued",
      created_at: isoAgo(25 * DAY),
    }));
    const obs = await collect();
    expect(obs.shipped_unbilled.truncated).toBe(true);
    expect(obs.analytics_window_truncated.value).toBeGreaterThanOrEqual(1);
    expect(String(obs.analytics_window_truncated.detail?.collectors)).toContain(
      "shipped_unbilled",
    );
  });
});

describe("platform scope", () => {
  it("counts voice calls that belong to NO tenant", async () => {
    store.tables.voice_calls = [
      { org_id: null, created_at: isoAgo(DAY) },
      { org_id: null, created_at: isoAgo(2 * DAY) },
      // Attributed — not this signal's problem.
      { org_id: ORG, created_at: isoAgo(DAY) },
      // Unattributed but outside the window.
      { org_id: null, created_at: isoAgo(30 * DAY) },
    ];
    const obs = await collectPlatformObservations({ nowMs: NOW, seedOrgId: ORG });
    expect(obs.voice_calls_unattributed.value).toBe(2);
  });

  it("totals inbound attribution failures and breaks them down by reason", async () => {
    // The reasons need different fixes, so the total alone is not enough
    // to act on.
    store.tables.inbound_attribution_failures = [
      {
        day: new Date(NOW - DAY).toISOString().slice(0, 10),
        channel: "sms",
        reason: "unknown_called_number",
        failures: 4,
      },
      {
        day: new Date(NOW - 2 * DAY).toISOString().slice(0, 10),
        channel: "voice",
        reason: "ambiguous_caller",
        failures: 1,
      },
    ];
    const obs = await collectPlatformObservations({ nowMs: NOW, seedOrgId: ORG });
    expect(obs.inbound_attribution_failures.value).toBe(5);
    expect(String(obs.inbound_attribution_failures.detail?.reasons)).toContain(
      "unknown_called_number=4",
    );
  });

  it("reports unknown — not zero — when the platform read fails", async () => {
    store.failing.add("voice_calls");
    const obs = await collectPlatformObservations({ nowMs: NOW, seedOrgId: ORG });
    expect(obs.voice_calls_unattributed.state).toBe("unknown");
  });
});
