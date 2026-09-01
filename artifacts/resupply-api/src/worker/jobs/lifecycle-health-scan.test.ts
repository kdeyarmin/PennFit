// The scan's own arithmetic: how many alerts it opens, how many
// messages it produces, and what it writes.
//
// `scanScope` is the seam worth testing. The registration wrapper is
// pg-boss plumbing; the question that decides whether this subsystem is
// tolerable is "how many notifications does one scan produce", and it is
// answerable only here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

interface Written {
  table: string;
  op: "insert" | "update" | "upsert";
  payload: Record<string, unknown>;
}

const { db } = vi.hoisted(() => ({
  db: {
    /** Open alert rows the fake returns from `lifecycle_health_alerts`. */
    openRows: [] as Array<Record<string, unknown>>,
    writes: [] as Written[],
    failReads: false,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => {
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        is: () => self,
        insert: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "update", payload });
          return { eq: () => Promise.resolve({ error: null }) };
        },
        upsert: (payload: Record<string, unknown>) => {
          db.writes.push({ table, op: "upsert", payload });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            db.failReads
              ? { data: null, error: { message: "down" } }
              : {
                  data: table === "lifecycle_health_alerts" ? db.openRows : [],
                  error: null,
                },
          ),
      };
      return self;
    },
  }),
  resolveSeedOrgId: async () => ORG,
  listActiveOrgIds: async () => [ORG],
}));

const { scanScope } = await import("./lifecycle-health-scan");
const { findSignal } = await import("../../lib/lifecycle-health/signals");
const { PLATFORM_SCOPE } = await import("../../lib/lifecycle-health/alerts");

const shippedUnbilled = findSignal("shipped_unbilled")!;
const denialRate = findSignal("payer_denial_rate")!;

async function scan(
  observations: Record<string, unknown>,
  signals = [shippedUnbilled],
  scopeId = ORG,
) {
  const { getOrgScopedClient } = await import("@workspace/resupply-db");
  return scanScope({
    scopeId,
    orgId: scopeId === PLATFORM_SCOPE ? null : scopeId,
    signals,
    observations: observations as never,
    db: getOrgScopedClient(scopeId),
    nowMs: NOW,
    env: {},
  });
}

beforeEach(() => {
  db.openRows = [];
  db.writes = [];
  db.failReads = false;
});

describe("counting", () => {
  it("tallies the six statuses separately", async () => {
    const { result } = await scan(
      {
        shipped_unbilled: { state: "measured", value: 100 },
        payer_denial_rate: { state: "not_configured", value: null },
      },
      [shippedUnbilled, denialRate],
    );
    expect(result.evaluated).toBe(2);
    expect(result.failures).toBe(1);
    expect(result.notConfigured).toBe(1);
    expect(result.warnings).toBe(0);
  });

  it("counts a signal with NO observation as unknown, not ok", async () => {
    // A signal added to the catalog and never wired up must be visible.
    const { result } = await scan({});
    expect(result.unknown).toBe(1);
    expect(result.evaluated).toBe(1);
  });
});

describe("what one scan produces", () => {
  it("opens an alert and offers exactly one digest item for a new failure", async () => {
    const { result, items } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(result.opened).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0].signal.key).toBe("shipped_unbilled");
    const insert = db.writes.find((w) => w.op === "insert");
    expect(insert?.table).toBe("lifecycle_health_alerts");
    expect(insert?.payload).toMatchObject({
      scope_id: ORG,
      org_id: ORG,
      signal_key: "shipped_unbilled",
      status: "failure",
      peak_status: "failure",
      notify_count: 1,
    });
  });

  it("says NOTHING on the second scan of the same unchanged failure", async () => {
    db.openRows = [
      {
        id: "a1",
        signal_key: "shipped_unbilled",
        status: "failure",
        peak_status: "failure",
        first_observed_at: new Date(NOW - 3 * 3_600_000).toISOString(),
        last_observed_at: new Date(NOW - 3_600_000).toISOString(),
        last_notified_at: new Date(NOW - 3_600_000).toISOString(),
        last_notified_status: "failure",
        notify_count: 1,
        observed_value: 100,
      },
    ];
    const { result, items } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(result.suppressed).toBe(1);
    expect(result.opened).toBe(0);
    expect(items).toHaveLength(0);
    // The row is still refreshed — the panel needs a current value even
    // when nobody is told.
    const update = db.writes.find(
      (w) => w.op === "update" && w.table === "lifecycle_health_alerts",
    );
    expect(update?.payload).toMatchObject({ observed_value: 100 });
    expect(update?.payload).not.toHaveProperty("last_notified_at");
  });

  it("escalates a warning that became a failure, inside the quiet window", async () => {
    db.openRows = [
      {
        id: "a1",
        signal_key: "shipped_unbilled",
        status: "warning",
        peak_status: "warning",
        first_observed_at: new Date(NOW - 3_600_000).toISOString(),
        last_observed_at: new Date(NOW - 60_000).toISOString(),
        last_notified_at: new Date(NOW - 60_000).toISOString(),
        last_notified_status: "warning",
        notify_count: 1,
        observed_value: 12,
      },
    ];
    const { result, items } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(result.escalated).toBe(1);
    expect(items).toHaveLength(1);
    const update = db.writes.find((w) => w.op === "update");
    expect(update?.payload).toMatchObject({
      status: "failure",
      peak_status: "failure",
      notify_count: 2,
    });
  });

  it("keeps the PEAK when a failure improves to a warning, and stays quiet", async () => {
    db.openRows = [
      {
        id: "a1",
        signal_key: "shipped_unbilled",
        status: "failure",
        peak_status: "failure",
        first_observed_at: new Date(NOW - 3_600_000).toISOString(),
        last_observed_at: new Date(NOW - 60_000).toISOString(),
        last_notified_at: new Date(NOW - 60_000).toISOString(),
        last_notified_status: "failure",
        notify_count: 1,
        observed_value: 100,
      },
    ];
    const { items } = await scan({
      shipped_unbilled: { state: "measured", value: 12 },
    });
    expect(items).toHaveLength(0);
    const update = db.writes.find((w) => w.op === "update");
    expect(update?.payload).toMatchObject({
      status: "warning",
      peak_status: "failure",
    });
  });

  it("resolves with a reason when the signal recovers", async () => {
    db.openRows = [
      {
        id: "a1",
        signal_key: "shipped_unbilled",
        status: "failure",
        peak_status: "failure",
        first_observed_at: new Date(NOW - 3_600_000).toISOString(),
        last_observed_at: new Date(NOW - 60_000).toISOString(),
        last_notified_at: new Date(NOW - 60_000).toISOString(),
        last_notified_status: "failure",
        notify_count: 1,
        observed_value: 100,
      },
    ];
    const { result, items } = await scan({
      shipped_unbilled: { state: "measured", value: 0 },
    });
    expect(result.resolved).toBe(1);
    expect(items).toHaveLength(1);
    const update = db.writes.find((w) => w.op === "update");
    expect(update?.payload).toMatchObject({ resolved_reason: "recovered" });
  });

  it("does NOT resolve an open alert when the read fails", async () => {
    // A database hiccup must not clear the board and announce that every
    // problem went away.
    db.openRows = [
      {
        id: "a1",
        signal_key: "shipped_unbilled",
        status: "failure",
        peak_status: "failure",
        first_observed_at: new Date(NOW - 3_600_000).toISOString(),
        last_observed_at: new Date(NOW - 60_000).toISOString(),
        last_notified_at: new Date(NOW - 60_000).toISOString(),
        last_notified_status: "failure",
        notify_count: 1,
        observed_value: 100,
      },
    ];
    const { result, items } = await scan({
      shipped_unbilled: { state: "unknown", value: null },
    });
    expect(result.resolved).toBe(0);
    expect(items).toHaveLength(0);
    expect(
      db.writes.some((w) => w.op === "update" && "resolved_at" in w.payload),
    ).toBe(false);
  });
});

describe("the snapshot is written for EVERY signal", () => {
  it("records healthy signals too, so silence is distinguishable from absence", async () => {
    // "The monitor is quiet" and "the monitor has not run since Tuesday"
    // are different states, and only `observed_at` tells them apart.
    await scan(
      {
        shipped_unbilled: { state: "measured", value: 0 },
        payer_denial_rate: { state: "disabled", value: null },
      },
      [shippedUnbilled, denialRate],
    );
    const upserts = db.writes.filter(
      (w) => w.table === "lifecycle_health_observations",
    );
    expect(upserts).toHaveLength(2);
    expect(upserts.map((u) => u.payload.status).sort()).toEqual([
      "disabled",
      "ok",
    ]);
  });

  it("scopes a platform-scope row with a null org and the sentinel", async () => {
    // `org_id` NULL with `scope_id = 'platform'` — the shape the CHECK
    // constraint enforces.
    await scan(
      { shipped_unbilled: { state: "measured", value: 0 } },
      [shippedUnbilled],
      PLATFORM_SCOPE,
    );
    const upsert = db.writes.find(
      (w) => w.table === "lifecycle_health_observations",
    );
    expect(upsert?.payload).toMatchObject({
      scope_id: "platform",
      org_id: null,
    });
  });
});

describe("failure posture", () => {
  it("throws rather than re-notifying everything when the open set is unreadable", async () => {
    // Without the open set every alerting signal looks brand new. The
    // quieter wrong answer is to skip the scope and retry next tick.
    db.failReads = true;
    await expect(
      scan({ shipped_unbilled: { state: "measured", value: 100 } }),
    ).rejects.toBeTruthy();
  });
});
