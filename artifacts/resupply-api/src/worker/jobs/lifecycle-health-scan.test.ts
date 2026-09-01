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
  /** Which client the write went through — scoped (tenant) or raw (platform). */
  via: "scoped" | "raw";
}

const { db } = vi.hoisted(() => ({
  db: {
    /** Open alert rows the fake returns from `lifecycle_health_alerts`. */
    openRows: [] as Array<Record<string, unknown>>,
    writes: [] as Written[],
    failReads: false,
    /** Simulate the partial unique index rejecting a concurrent open. */
    insertConflicts: false,
  },
}));

function makeBuilder(table: string, via: "scoped" | "raw") {
  const self: Record<string, unknown> = {
    select: () => self,
    eq: () => self,
    is: () => self,
    insert: (payload: Record<string, unknown>) => {
      db.writes.push({ table, op: "insert", payload, via });
      return Promise.resolve({
        error: db.insertConflicts ? { message: "duplicate key" } : null,
      });
    },
    update: (payload: Record<string, unknown>) => {
      db.writes.push({ table, op: "update", payload, via });
      const chain: Record<string, unknown> = {
        eq: () => chain,
        is: () => chain,
        then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
      };
      return chain;
    },
    upsert: (payload: Record<string, unknown>) => {
      db.writes.push({ table, op: "upsert", payload, via });
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
}

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => makeBuilder(table, "scoped"),
    // The platform pass must NOT go through the org-scoped builder: those
    // rows carry `org_id IS NULL` by CHECK constraint and the scoped
    // client force-tags every write with a tenant id.
    raw: () => ({
      schema: () => ({
        from: (table: string) => makeBuilder(table, "raw"),
      }),
    }),
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
  db.insertConflicts = false;
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
    });
    // Opened UNNOTIFIED. Nothing has been sent yet at this point, and
    // `last_notified_at` is the field that buys 24 hours of silence.
    expect(insert?.payload.notify_count).toBe(0);
    expect(insert?.payload.last_notified_at).toBeNull();
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
    });
    // The transition write does not touch the notification bookkeeping.
    expect(update?.payload).not.toHaveProperty("notify_count");
    expect(update?.payload).not.toHaveProperty("last_notified_at");
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

  it("writes platform rows through the RAW client, never the org-scoped one", async () => {
    // `getOrgScopedClient` force-tags every write with its tenant id — it
    // overwrites an explicit `org_id: null` rather than deferring to it.
    // A platform write through it produces a row the CHECK constraint
    // rejects, and the rejection is indistinguishable from the benign
    // duplicate-open race the insert path tolerates. So it would fail
    // silently, forever.
    await scan(
      { shipped_unbilled: { state: "measured", value: 100 } },
      [shippedUnbilled],
      PLATFORM_SCOPE,
    );
    expect(db.writes.length).toBeGreaterThan(0);
    expect(db.writes.every((w) => w.via === "raw")).toBe(true);
  });

  it("writes tenant rows through the ORG-SCOPED client", async () => {
    await scan({ shipped_unbilled: { state: "measured", value: 100 } });
    expect(db.writes.length).toBeGreaterThan(0);
    expect(db.writes.every((w) => w.via === "scoped")).toBe(true);
  });
});

describe("notification is earned, not assumed", () => {
  it("stamps last_notified_at only when confirmNotified is called", async () => {
    const { items, confirmNotified } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(items).toHaveLength(1);
    // Before the send: nothing suppresses the next scan.
    expect(
      db.writes.some(
        (w) => "last_notified_at" in w.payload && w.op === "update",
      ),
    ).toBe(false);

    const stamped = await confirmNotified();
    expect(stamped).toBe(1);
    const stamp = db.writes.find(
      (w) => w.op === "update" && "last_notified_at" in w.payload,
    );
    expect(stamp?.payload).toMatchObject({
      last_notified_status: "failure",
      notify_count: 1,
    });
  });

  it("leaves the alert unstamped when the digest is never delivered", async () => {
    // A failed send must cost ONE scan interval, not a full quiet window.
    // An unstamped open alert reads as "nobody was ever told", which
    // `decideAlertAction` turns into a renotify on the next tick.
    await scan({ shipped_unbilled: { state: "measured", value: 100 } });
    expect(
      db.writes.some(
        (w) => "last_notified_at" in w.payload && w.op === "update",
      ),
    ).toBe(false);
  });

  it("carries the escalated count forward when it does stamp", async () => {
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
        notify_count: 4,
        observed_value: 12,
      },
    ];
    const { confirmNotified } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    await confirmNotified();
    const stamp = db.writes.find(
      (w) => w.op === "update" && "last_notified_at" in w.payload,
    );
    expect(stamp?.payload.notify_count).toBe(5);
  });

  it("says nothing about an alert a concurrent scan opened first", async () => {
    // The partial unique index is the arbiter. If this insert lost the
    // race, the other worker is already reporting it — notifying anyway
    // sends the duplicate the index exists to prevent.
    db.insertConflicts = true;
    const { result, items } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(items).toHaveLength(0);
    expect(result.opened).toBe(0);
    expect(result.conflicted).toBe(1);
  });

  it("does not stamp a notification for a conflicted open", async () => {
    db.insertConflicts = true;
    const { confirmNotified } = await scan({
      shipped_unbilled: { state: "measured", value: 100 },
    });
    expect(await confirmNotified()).toBe(0);
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
