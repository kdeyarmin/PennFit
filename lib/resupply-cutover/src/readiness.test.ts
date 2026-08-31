// Readiness assessment — the gate that decides whether a tenant's data
// can survive each flag being turned on.
//
// The fixture below is a hand-rolled PostgREST-shaped fake rather than a
// mocked query builder, because what these tests need to control is the
// DATA, not the call sequence — and because two of the cases (pagination
// truncation, tenant isolation) are only meaningful against something
// that actually pages and actually filters by org.

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Tables {
  prescriptions: Array<Record<string, unknown>>;
  episodes: Array<Record<string, unknown>>;
  patients: Array<Record<string, unknown>>;
  fulfillments: Array<Record<string, unknown>>;
  frequency_rules: Array<Record<string, unknown>>;
  insurance_claims: Array<Record<string, unknown>>;
  feature_flags: Array<Record<string, unknown>>;
}

/** Per-org tables, so a leak across tenants is observable. */
const db = new Map<string, Tables>();

function emptyTables(): Tables {
  return {
    prescriptions: [],
    episodes: [],
    patients: [],
    fulfillments: [],
    frequency_rules: [],
    insurance_claims: [],
    insurance_claims_extra: [],
  } as unknown as Tables;
}

function seed(orgId: string, tables: Partial<Tables>): void {
  db.set(orgId, { ...emptyTables(), feature_flags: [], ...tables } as Tables);
}

/**
 * A minimal PostgREST-shaped builder: filters compose, `.range()` pages,
 * and `count: exact, head: true` returns a count without rows — the three
 * behaviours the assessor depends on.
 */
function makeBuilder(rows: Array<Record<string, unknown>>) {
  let filtered = [...rows];
  let counting = false;
  const builder = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      counting = Boolean(opts?.head);
      return builder;
    },
    eq(col: string, value: unknown) {
      filtered = filtered.filter((r) => r[col] === value);
      return builder;
    },
    neq(col: string, value: unknown) {
      filtered = filtered.filter((r) => r[col] !== value);
      return builder;
    },
    in(col: string, values: unknown[]) {
      filtered = filtered.filter((r) => values.includes(r[col]));
      return builder;
    },
    gte(col: string, value: string) {
      filtered = filtered.filter((r) => String(r[col] ?? "") >= value);
      return builder;
    },
    lt(col: string, value: string) {
      filtered = filtered.filter((r) => String(r[col] ?? "") < value);
      return builder;
    },
    is(col: string, value: null) {
      void value;
      filtered = filtered.filter(
        (r) => r[col] === null || r[col] === undefined,
      );
      return builder;
    },
    not(col: string, _op: string, value: null) {
      void value;
      filtered = filtered.filter(
        (r) => r[col] !== null && r[col] !== undefined,
      );
      return builder;
    },
    order(col: string) {
      filtered.sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      return builder;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return builder;
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    range(from: number, to: number) {
      return Promise.resolve({
        data: filtered.slice(from, to + 1),
        error: null,
      });
    },
    then(resolve: (v: { data: unknown; error: null; count?: number }) => void) {
      resolve(
        counting
          ? { data: null, error: null, count: filtered.length }
          : { data: filtered, error: null, count: filtered.length },
      );
    },
  };
  return builder;
}

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({
    from: (table: keyof Tables) => {
      const tables = db.get(orgId) ?? emptyTables();
      return makeBuilder(tables[table] ?? []);
    },
  }),
}));

const {
  assessDueAtReadiness,
  assessShipEvidenceReadiness,
  readCutoverFlagState,
} = await import("./readiness");

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ORG = "org-a";

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
}

beforeEach(() => {
  db.clear();
});

describe("assessDueAtReadiness", () => {
  it("is ready, with a warning, for a tenant with no open episodes", async () => {
    seed(ORG, { prescriptions: [], episodes: [] });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.status).toBe("ready");
    expect(report.warnings.join(" ")).toContain("nothing for the flag to move");
  });

  it("is ready when every stored due date already agrees with the resolved cadence", async () => {
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: null,
          channel_preference: null,
          phone_e164: "+12155550100",
        },
      ],
      fulfillments: [
        {
          id: "f1",
          patient_id: "p1",
          item_sku: "SKU-A",
          status: "shipped",
          shipped_at: iso(30),
          created_at: iso(35),
        },
      ],
      episodes: [
        {
          id: "e1",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "outreach_pending",
          // shipped 30d ago + 90d cadence = 60d in the future.
          due_at: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
        },
      ],
    });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.metrics.agreeing).toBe(1);
    expect(report.metrics.drifting).toBe(0);
    expect(report.status).toBe("ready");
  });

  it("BLOCKS when a per-patient cadence override makes the stored date wrong", async () => {
    // This is the whole reason the flag is off: `due_at` is written from
    // the prescription's cadence, while the scan resolves the patient's
    // override. Flipping the flag with this drift present reminds the
    // patient a month early.
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: 30,
          channel_preference: null,
          phone_e164: "+12155550100",
        },
      ],
      fulfillments: [
        {
          id: "f1",
          patient_id: "p1",
          item_sku: "SKU-A",
          status: "shipped",
          shipped_at: iso(30),
          created_at: iso(35),
        },
      ],
      episodes: [
        {
          id: "e1",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "awaiting_response",
          due_at: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
        },
      ],
    });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.status).toBe("blocked");
    expect(report.metrics.drifting).toBe(1);
    expect(report.metrics.driftingEarlier).toBe(1);
    expect(report.metrics.maxDriftEarlierDays).toBe(60);
    expect(report.blockers.map((b) => b.code)).toContain("due_at_drift");
    expect(report.sampleDriftingEpisodeIds).toEqual(["e1"]);
  });

  it("counts address_hold episodes — a parked cycle still carries a stale date", async () => {
    // Filtering these out would let a dry-run call a tenant safe while a
    // held episode carries a stale cadence-derived date; releasing the
    // hold after the flag is on hands the scan that stale date.
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: 30,
          channel_preference: null,
          phone_e164: null,
        },
      ],
      episodes: [
        {
          id: "e-hold",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "address_hold",
          due_at: new Date(NOW.getTime() + 300 * DAY_MS).toISOString(),
        },
      ],
    });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.metrics.addressHoldEpisodes).toBe(1);
    expect(report.metrics.byStatus.address_hold).toBe(1);
    expect(report.status).toBe("blocked");
  });

  it("BLOCKS on an episode with no due date at all", async () => {
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: null,
          channel_preference: null,
          phone_e164: null,
        },
      ],
      episodes: [
        {
          id: "e1",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "outreach_pending",
          due_at: null,
        },
      ],
    });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.status).toBe("blocked");
    expect(report.metrics.missingDueAt).toBe(1);
    expect(report.blockers.map((b) => b.code)).toContain("missing_due_at");
  });

  it("BLOCKS rather than passing when the scan is truncated", async () => {
    // A partial clean read is not evidence of a clean tenant. Reporting
    // "ready" off a truncated scan is the failure mode that matters.
    const episodes = Array.from({ length: 250 }, (_, i) => ({
      id: `e${String(i).padStart(4, "0")}`,
      patient_id: "p1",
      prescription_id: "rx1",
      status: "outreach_pending",
      due_at: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
    }));
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: null,
          channel_preference: null,
          phone_e164: null,
        },
      ],
      fulfillments: [
        {
          id: "f1",
          patient_id: "p1",
          item_sku: "SKU-A",
          status: "shipped",
          shipped_at: iso(30),
          created_at: iso(35),
        },
      ],
      episodes,
    });
    const report = await assessDueAtReadiness(ORG, {
      now: NOW,
      maxEpisodes: 200,
    });
    expect(report.truncated).toBe(true);
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((b) => b.code)).toContain(
      "assessment_truncated",
    );
  });

  it("counts an unresolvable episode instead of quietly dropping it", async () => {
    seed(ORG, {
      prescriptions: [],
      patients: [],
      episodes: [
        {
          id: "orphan",
          patient_id: "gone",
          prescription_id: "gone",
          status: "outreach_pending",
          due_at: iso(1),
        },
      ],
    });
    const report = await assessDueAtReadiness(ORG, { now: NOW });
    expect(report.metrics.unresolvable).toBe(1);
    expect(report.metrics.byReason.missing_prescription_or_patient).toBe(1);
    expect(report.warnings.join(" ")).toContain("could not be evaluated");
  });

  it("never leaks a name, phone or payer into the report", async () => {
    seed(ORG, {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: "Highmark Blue Shield",
          cadence_override_days: 30,
          channel_preference: null,
          phone_e164: "+12155550100",
        },
      ],
      episodes: [
        {
          id: "e1",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "outreach_pending",
          due_at: new Date(NOW.getTime() + 300 * DAY_MS).toISOString(),
        },
      ],
    });
    const serialized = JSON.stringify(
      await assessDueAtReadiness(ORG, { now: NOW }),
    );
    expect(serialized).not.toContain("Highmark");
    expect(serialized).not.toContain("2155550100");
  });

  it("assesses each tenant from its own data only", async () => {
    seed("org-a", { prescriptions: [], episodes: [] });
    seed("org-b", {
      prescriptions: [
        {
          id: "rx1",
          status: "active",
          item_sku: "SKU-A",
          cadence_days: 90,
          created_at: iso(200),
        },
      ],
      patients: [
        {
          id: "p1",
          created_at: iso(400),
          insurance_payer: null,
          cadence_override_days: 30,
          channel_preference: null,
          phone_e164: null,
        },
      ],
      episodes: [
        {
          id: "e-b",
          patient_id: "p1",
          prescription_id: "rx1",
          status: "outreach_pending",
          due_at: new Date(NOW.getTime() + 300 * DAY_MS).toISOString(),
        },
      ],
    });
    expect((await assessDueAtReadiness("org-a", { now: NOW })).status).toBe(
      "ready",
    );
    expect((await assessDueAtReadiness("org-b", { now: NOW })).status).toBe(
      "blocked",
    );
  });
});

describe("assessShipEvidenceReadiness", () => {
  it("BLOCKS a tenant with no shipment-evidence pathway at all", async () => {
    seed(ORG, { fulfillments: [], episodes: [], insurance_claims: [] });
    const report = await assessShipEvidenceReadiness(ORG, { now: NOW });
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((b) => b.code)).toContain(
      "no_shipment_evidence_pathway",
    );
    expect(report.pathways).toEqual({
      pacwareImport: false,
      adminManual: false,
      carrier: false,
    });
  });

  it("is ready when the PacWare import is producing real ship dates", async () => {
    seed(ORG, {
      fulfillments: [
        {
          id: "f1",
          shipped_at: iso(10),
          status: "shipped",
          created_at: iso(12),
          shipment_metadata: { source: "pacware_import" },
        },
      ],
      episodes: [{ id: "e1", closed_reason: "shipped", closed_at: iso(10) }],
      insurance_claims: [
        { id: "c1", fulfillment_id: "f1", created_at: iso(9) },
      ],
    });
    const report = await assessShipEvidenceReadiness(ORG, { now: NOW });
    expect(report.status).toBe("ready");
    expect(report.pathways.pacwareImport).toBe(true);
    expect(report.metrics.viaPacwareImport).toBe(1);
    expect(report.metrics.claimsAnchoredToShipEvidence).toBe(1);
    expect(report.metrics.claimsWithoutShipEvidence).toBe(0);
  });

  it("warns, but does not block, when only manual marking is in use", async () => {
    seed(ORG, {
      fulfillments: [
        {
          id: "f1",
          shipped_at: iso(10),
          status: "shipped",
          created_at: iso(12),
          shipment_metadata: { source: "admin_manual" },
        },
      ],
      episodes: [],
      insurance_claims: [],
    });
    const report = await assessShipEvidenceReadiness(ORG, { now: NOW });
    expect(report.status).toBe("ready");
    expect(report.warnings.join(" ")).toContain("only from manual entry");
  });

  it("BLOCKS on a backlog of queued-and-never-shipped orders", async () => {
    const fulfillments = [
      {
        id: "shipped-1",
        shipped_at: iso(5),
        status: "shipped",
        created_at: iso(7),
        shipment_metadata: { source: "pacware_import" },
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `stuck-${i}`,
        shipped_at: null,
        status: "queued",
        created_at: iso(60),
        shipment_metadata: null,
      })),
    ];
    seed(ORG, { fulfillments, episodes: [], insurance_claims: [] });
    const report = await assessShipEvidenceReadiness(ORG, {
      now: NOW,
      unresolvedShipmentFailureThreshold: 25,
    });
    expect(report.metrics.fulfilledNotShipped).toBe(30);
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((b) => b.code)).toContain(
      "unresolved_shipment_backlog",
    );
    expect(report.sampleUnshippedFulfillmentIds.length).toBeGreaterThan(0);
  });

  it("respects a configured threshold instead of a hard-coded one", async () => {
    const fulfillments = [
      {
        id: "shipped-1",
        shipped_at: iso(5),
        status: "shipped",
        created_at: iso(7),
        shipment_metadata: { source: "pacware_import" },
      },
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `stuck-${i}`,
        shipped_at: null,
        status: "queued",
        created_at: iso(60),
        shipment_metadata: null,
      })),
    ];
    seed(ORG, { fulfillments, episodes: [], insurance_claims: [] });
    const report = await assessShipEvidenceReadiness(ORG, {
      now: NOW,
      unresolvedShipmentFailureThreshold: 100,
    });
    expect(report.status).toBe("ready");
    expect(report.warnings.join(" ")).toContain("within threshold");
  });

  it("keeps assumed_shipped separate from shipped, and blocks when it dominates", async () => {
    // assumed_shipped is the grace sweep advancing a ladder that never
    // got confirmation. It is deliberately NOT a shipment and can never
    // date a claim; if the two ever collapse into one number the flag's
    // premise is gone.
    seed(ORG, {
      fulfillments: [
        {
          id: "f1",
          shipped_at: iso(10),
          status: "shipped",
          created_at: iso(12),
          shipment_metadata: { source: "admin_manual" },
        },
      ],
      episodes: [
        { id: "e-real", closed_reason: "shipped", closed_at: iso(10) },
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `e-assumed-${i}`,
          closed_reason: "assumed_shipped",
          closed_at: iso(20),
        })),
      ],
      insurance_claims: [],
    });
    const report = await assessShipEvidenceReadiness(ORG, {
      now: NOW,
      unresolvedShipmentFailureThreshold: 25,
    });
    expect(report.metrics.assumedShippedEpisodes).toBe(40);
    expect(report.metrics.shippedEpisodes).toBe(1);
    expect(report.status).toBe("blocked");
    expect(report.blockers.map((b) => b.code)).toContain(
      "assumed_shipped_dominates",
    );
  });

  it("counts a claim built with no shipment evidence behind it", async () => {
    seed(ORG, {
      fulfillments: [
        {
          id: "f-shipped",
          shipped_at: iso(10),
          status: "shipped",
          created_at: iso(12),
          shipment_metadata: { source: "pacware_import" },
        },
      ],
      episodes: [],
      insurance_claims: [
        { id: "c1", fulfillment_id: "f-shipped", created_at: iso(9) },
        { id: "c2", fulfillment_id: "f-unshipped", created_at: iso(9) },
      ],
    });
    const report = await assessShipEvidenceReadiness(ORG, { now: NOW });
    expect(report.metrics.claimsAnchoredToShipEvidence).toBe(1);
    expect(report.metrics.claimsWithoutShipEvidence).toBe(1);
  });
});

describe("readCutoverFlagState", () => {
  it("reads the stored row, not a cache", async () => {
    seed(ORG, {
      feature_flags: [
        { key: "resupply.due_at_authoritative", enabled: true },
        { key: "resupply.ship_evidence_required", enabled: false },
      ],
    } as Partial<Tables>);
    await expect(
      readCutoverFlagState(ORG, "resupply.due_at_authoritative"),
    ).resolves.toBe(true);
    await expect(
      readCutoverFlagState(ORG, "resupply.ship_evidence_required"),
    ).resolves.toBe(false);
  });

  it("reports false for a tenant with no row, rather than inheriting a default", async () => {
    seed(ORG, {});
    await expect(
      readCutoverFlagState(ORG, "resupply.due_at_authoritative"),
    ).resolves.toBe(false);
  });
});
