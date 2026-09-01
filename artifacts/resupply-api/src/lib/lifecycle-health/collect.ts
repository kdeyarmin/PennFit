// Measure the signals. One pass, one tenant.
//
// RULES EVERY COLLECTOR FOLLOWS
// -----------------------------
// 1. A failed read produces `unknown`, never a zero. This is the whole
//    reason the state field exists: a monitor that reports zero when it
//    cannot read is worse than no monitor, because it actively asserts
//    that things are fine.
// 2. Counts use `head: true`, which is a COUNT at the database and is
//    not subject to PostgREST's ~1000-row cap. A backlog of five
//    thousand reports five thousand.
// 3. Where rows genuinely must be fetched (an average needs the values,
//    an anti-join needs the ids), the read is PAGED and CAPPED, and
//    hitting the cap sets `truncated`. A truncated number is a FLOOR,
//    the panel says so, and the `analytics_window_truncated` meta-signal
//    counts how many collectors did it — because a dashboard whose
//    backlog silently stops growing at the cap is how a growing problem
//    becomes invisible.
// 4. Nothing here reads a patient's name, phone, address or clinical
//    data. Ids are fetched only where an anti-join requires them and are
//    never returned, logged or stored.
// 5. Every collector is independent. One broken table blanks one row,
//    not the panel.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  CUTOVER_FLAG_KEYS,
  hasFreshReadyAssessment,
  readCutoverFlagState,
} from "@workspace/resupply-cutover";
import { OUTREACH_OPEN_EPISODE_STATUSES } from "@workspace/resupply-domain";

import {
  readGate,
  ageStatus,
  escalationMultiplier,
} from "../approval-gates/read";
import { APPROVAL_GATES, findApprovalGate } from "../approval-gates/registry";
import { logger } from "../logger";

import type { SignalObservation } from "./evaluate";
import { LIFECYCLE_SIGNALS, TENANT_SIGNALS } from "./signals";

type Db = ReturnType<typeof getOrgScopedClient>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** PostgREST page size. */
const PAGE_SIZE = 1000;
/** `.in()` batch size for the anti-join passes. */
const READ_CHUNK = 200;
/**
 * Hard ceiling on any row-fetching collector.
 *
 * Five pages. A tenant past this is reported as truncated rather than
 * scanned indefinitely: a health check that takes minutes is one that
 * gets disabled, and a floor delivered on time beats an exact number
 * nobody waits for.
 */
const MAX_ROWS = 5 * PAGE_SIZE;

export type Observations = Record<string, SignalObservation>;

/** Filters, as data, so one helper can count any shape of queue. */
type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "gte" | "gt" | "lte" | "lt"; column: string; value: string | number }
  | { op: "in"; column: string; values: readonly unknown[] }
  | { op: "isNull"; column: string }
  | { op: "notNull"; column: string };

interface FilterableQuery {
  eq: (c: string, v: unknown) => FilterableQuery;
  gte: (c: string, v: unknown) => FilterableQuery;
  gt: (c: string, v: unknown) => FilterableQuery;
  lte: (c: string, v: unknown) => FilterableQuery;
  lt: (c: string, v: unknown) => FilterableQuery;
  in: (c: string, v: readonly unknown[]) => FilterableQuery;
  is: (c: string, v: null) => FilterableQuery;
  not: (c: string, op: string, v: null) => FilterableQuery;
}

function applyFilters<T>(query: T, filters: readonly Filter[]): T {
  let q = query as unknown as FilterableQuery;
  for (const f of filters) {
    switch (f.op) {
      case "eq":
        q = q.eq(f.column, f.value);
        break;
      case "gte":
      case "gt":
      case "lte":
      case "lt":
        q = q[f.op](f.column, f.value);
        break;
      case "in":
        q = q.in(f.column, f.values);
        break;
      case "isNull":
        q = q.is(f.column, null);
        break;
      case "notNull":
        q = q.not(f.column, "is", null);
        break;
    }
  }
  return q as unknown as T;
}

/**
 * A database-side COUNT of a filtered queue.
 *
 * `head: true` means PostgREST returns the count in a header and no rows
 * at all, so this is exact regardless of how large the queue is.
 */
async function countWhere(
  db: Db,
  table: string,
  filters: readonly Filter[],
): Promise<number> {
  const q = applyFilters(
    db
      .from(table as never)
      .select("*", { count: "exact", head: true }) as unknown as Record<
      string,
      unknown
    >,
    filters,
  );
  const { count, error } = (await q) as unknown as {
    count: number | null;
    error: unknown;
  };
  if (error) throw error;
  return count ?? 0;
}

/** Page a filtered read up to `MAX_ROWS`, reporting whether it capped. */
async function fetchRows<T>(
  db: Db,
  table: string,
  columns: string,
  filters: readonly Filter[],
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const q = applyFilters(
      db.from(table as never).select(columns) as unknown as Record<
        string,
        unknown
      >,
      filters,
    ) as unknown as {
      range: (
        a: number,
        b: number,
      ) => PromiseLike<{
        data: T[] | null;
        error: unknown;
      }>;
    };
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function hoursSince(
  iso: string | null | undefined,
  nowMs: number,
): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / HOUR_MS);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Run one collector, turning any throw into `unknown`.
 *
 * The error is logged with its NAME only — a PostgREST error message can
 * echo the filter values that produced it, and those filters carry
 * patient ids on the anti-join passes.
 */
async function safely(
  key: string,
  fn: () => Promise<SignalObservation>,
): Promise<SignalObservation> {
  try {
    return await fn();
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_health.collector_failed",
        signal: key,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: a collector failed; the signal reports unknown, not zero",
    );
    return {
      state: "unknown",
      value: null,
      reason: "The read for this signal failed. This is not a zero.",
    };
  }
}

const measured = (
  value: number,
  extra: Partial<SignalObservation> = {},
): SignalObservation => ({ state: "measured", value, ...extra });

export interface CollectOptions {
  /** Injected clock, so the whole scan shares one `now`. */
  nowMs?: number;
  /**
   * Observations the caller already has and this pass cannot take —
   * today, dead-letter depth, which needs a pg-boss handle.
   */
  extra?: Observations;
}

/**
 * Measure every tenant-scoped signal for one org.
 *
 * Collectors run CONCURRENTLY: they are independent reads and running
 * them in series would make a 27-signal scan as slow as the sum of its
 * parts on every tenant.
 */
export async function collectTenantObservations(
  orgId: string,
  options: CollectOptions = {},
): Promise<Observations> {
  const nowMs = options.nowMs ?? Date.now();
  const db = getOrgScopedClient(orgId);
  const out: Observations = {};

  const jobs: Array<[string, () => Promise<SignalObservation>]> = [
    ["cycle_creation_spike", () => collectCycleSpike(db, nowMs)],
    ["cycle_creation_stalled", () => collectCycleStalled(db, nowMs)],
    ["episodes_open_past_age", () => collectOpenPastExpiry(db, nowMs)],
    [
      "never_contacted_growth",
      () => collectClosedReason(db, nowMs, "never_contacted"),
    ],
    ["no_response_growth", () => collectClosedReason(db, nowMs, "no_response")],
    [
      "assumed_shipped_growth",
      () => collectClosedReason(db, nowMs, "assumed_shipped"),
    ],
    ["address_hold_aging", () => collectAddressHoldAging(db, nowMs)],
    ["shipment_evidence_lag", () => collectShipmentLag(db, nowMs)],
    ["fulfilled_not_shipped", () => collectQueuedNeverShipped(db, nowMs)],
    ["shipped_unbilled", () => collectShippedUnbilled(db, nowMs)],
    ["claims_stuck_submitting", () => collectStuckSubmitting(db, nowMs)],
    [
      "claims_missing_ship_evidence",
      () => collectClaimsMissingEvidence(db, orgId, nowMs),
    ],
    ["clearinghouse_rejection_rate", () => collectRejectionRate(db, nowMs)],
    ["payer_denial_rate", () => collectDenialRate(db, nowMs)],
    [
      "flags_without_readiness_evidence",
      () => collectFlagsWithoutEvidence(orgId, nowMs),
    ],
    ["approval_queues_past_sla", () => collectApprovalQueuesPastSla(db, nowMs)],
  ];

  // Two collectors answer several signals from one read each, and own
  // their own failure fan-out: a connector table that will not read
  // makes all four integration signals unknown, not three unknown and
  // one accidentally zero.
  const [pairs, connectorObs, pacwareObs] = await Promise.all([
    Promise.all(
      jobs.map(async ([key, fn]) => [key, await safely(key, fn)] as const),
    ),
    collectConnectorObservations(db, nowMs),
    collectPacwareObservations(db, nowMs),
  ]);

  for (const [key, observation] of pairs) out[key] = observation;
  Object.assign(out, connectorObs, pacwareObs);

  for (const [key, observation] of Object.entries(options.extra ?? {})) {
    out[key] = observation;
  }

  // Any tenant signal with no collector and no injected value is missing,
  // not healthy. Saying so is how a signal that was added to the catalog
  // and never wired up gets noticed.
  for (const signal of TENANT_SIGNALS) {
    if (signal.key === "analytics_window_truncated") continue;
    out[signal.key] ??= {
      state: "unknown",
      value: null,
      reason: "No reading was taken for this signal in this scan.",
    };
  }

  // The meta-signal, computed last from everything above.
  const truncatedKeys = Object.entries(out)
    .filter(([, o]) => o.truncated === true)
    .map(([k]) => k);
  out.analytics_window_truncated = measured(truncatedKeys.length, {
    detail: { collectors: truncatedKeys.join(", ") || "none" },
    reason:
      truncatedKeys.length > 0
        ? "The signals named here hit their row cap, so their numbers are floors rather than totals."
        : undefined,
  });

  return out;
}

// ── Intake ───────────────────────────────────────────────────────────

async function collectCycleSpike(db: Db, nowMs: number) {
  const recent = await countWhere(db, "episodes", [
    { op: "gte", column: "created_at", value: iso(nowMs - DAY_MS) },
  ]);
  const baseline = await countWhere(db, "episodes", [
    { op: "gte", column: "created_at", value: iso(nowMs - 15 * DAY_MS) },
    { op: "lt", column: "created_at", value: iso(nowMs - DAY_MS) },
  ]);
  const perDay = baseline / 14;
  // No history means no baseline. `minSample` (14 cycles over 14 days)
  // holds the breach back rather than declaring a brand-new tenant's
  // first three cycles a 3× spike.
  const value = perDay > 0 ? recent / perDay : 0;
  return measured(value, {
    sample: baseline,
    detail: { last24h: recent, baselinePerDay: Math.round(perDay * 100) / 100 },
  });
}

async function collectCycleStalled(db: Db, nowMs: number) {
  const activeRx = await countWhere(db, "prescriptions", [
    { op: "eq", column: "status", value: "active" },
  ]);
  if (activeRx === 0) {
    return {
      state: "disabled" as const,
      value: null,
      reason:
        "This tenant has no active prescriptions, so there is no resupply population to create cycles for.",
    };
  }

  const { rows } = await fetchRowsNewest<{ created_at: string }>(
    db,
    "episodes",
    "created_at",
    [],
    "created_at",
  );
  const latest = rows[0]?.created_at ?? null;
  if (latest) {
    return measured(hoursSince(latest, nowMs) ?? 0, {
      sample: activeRx,
      detail: { activePrescriptions: activeRx },
    });
  }

  // No cycle has EVER been created while this tenant has an eligible
  // population — the maximal form of the condition. Age it from the
  // oldest active prescription: that is genuinely how long we have had
  // patients to serve and produced nothing for them.
  const { rows: oldestRx } = await fetchRowsNewest<{ created_at: string }>(
    db,
    "prescriptions",
    "created_at",
    [{ op: "eq", column: "status", value: "active" }],
    "created_at",
    true,
  );
  return measured(hoursSince(oldestRx[0]?.created_at ?? null, nowMs) ?? 0, {
    sample: activeRx,
    detail: { activePrescriptions: activeRx, episodesEverCreated: 0 },
  });
}

/** One row, ordered. Used for "the newest X" / "the oldest X" lookups. */
async function fetchRowsNewest<T>(
  db: Db,
  table: string,
  columns: string,
  filters: readonly Filter[],
  orderColumn: string,
  ascending = false,
): Promise<{ rows: T[] }> {
  const q = applyFilters(
    db.from(table as never).select(columns) as unknown as Record<
      string,
      unknown
    >,
    filters,
  ) as unknown as {
    order: (
      c: string,
      o: { ascending: boolean },
    ) => {
      limit: (n: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
    };
  };
  const { data, error } = await q.order(orderColumn, { ascending }).limit(1);
  if (error) throw error;
  return { rows: data ?? [] };
}

async function collectOpenPastExpiry(db: Db, nowMs: number) {
  const value = await countWhere(db, "episodes", [
    { op: "in", column: "status", values: OUTREACH_OPEN_EPISODE_STATUSES },
    { op: "lt", column: "expires_at", value: iso(nowMs) },
  ]);
  return measured(value);
}

// ── Outreach ─────────────────────────────────────────────────────────

async function collectClosedReason(db: Db, nowMs: number, reason: string) {
  const value = await countWhere(db, "episodes", [
    { op: "eq", column: "closed_reason", value: reason },
    { op: "gte", column: "closed_at", value: iso(nowMs - 7 * DAY_MS) },
  ]);
  return measured(value, { detail: { windowDays: 7, closedReason: reason } });
}

async function collectAddressHoldAging(db: Db, nowMs: number) {
  // The expectation comes from the approval-gate registry rather than a
  // second number here, so the panel's "past SLA" and this alert cannot
  // drift into disagreeing about the same queue.
  const slaHours = findApprovalGate("address_change_confirm")?.slaHours ?? 24;
  const value = await countWhere(db, "episodes", [
    { op: "eq", column: "status", value: "address_hold" },
    { op: "lt", column: "updated_at", value: iso(nowMs - slaHours * HOUR_MS) },
  ]);
  return measured(value, { detail: { slaHours } });
}

// ── Fulfillment ──────────────────────────────────────────────────────

async function collectShipmentLag(db: Db, nowMs: number) {
  const { rows, truncated } = await fetchRows<{
    created_at: string;
    shipped_at: string;
  }>(db, "fulfillments", "created_at,shipped_at", [
    { op: "notNull", column: "shipped_at" },
    { op: "gte", column: "shipped_at", value: iso(nowMs - 14 * DAY_MS) },
  ]);
  if (rows.length === 0) {
    return {
      state: "disabled" as const,
      value: null,
      reason:
        "No shipment has been confirmed for this tenant in the last 14 days, so there is no lag to measure. If shipments ARE happening, the confirmation feed is the thing to look at.",
    };
  }
  let total = 0;
  let counted = 0;
  for (const row of rows) {
    const queued = Date.parse(row.created_at);
    const shipped = Date.parse(row.shipped_at);
    if (!Number.isFinite(queued) || !Number.isFinite(shipped)) continue;
    total += Math.max(0, (shipped - queued) / HOUR_MS);
    counted += 1;
  }
  if (counted === 0) {
    return {
      state: "unknown" as const,
      value: null,
      reason: "Shipment rows were found but none carried usable timestamps.",
    };
  }
  return measured(total / counted, {
    sample: counted,
    truncated,
    detail: { shipmentsSampled: counted, windowDays: 14 },
  });
}

async function collectQueuedNeverShipped(db: Db, nowMs: number) {
  const value = await countWhere(db, "fulfillments", [
    { op: "eq", column: "status", value: "queued" },
    { op: "isNull", column: "shipped_at" },
    { op: "lt", column: "created_at", value: iso(nowMs - 7 * DAY_MS) },
  ]);
  return measured(value, { detail: { olderThanDays: 7 } });
}

/**
 * Shipped, and no claim of any kind against it.
 *
 * Windowed 7-45 days back on purpose. Newer than 7 days is not yet late
 * — billing runs in batches — and older than 45 is past the point where
 * this number is actionable, so scanning it only makes the pass slower
 * and the number larger without making anyone do anything different.
 */
async function collectShippedUnbilled(db: Db, nowMs: number) {
  const { rows, truncated } = await fetchRows<{ id: string }>(
    db,
    "fulfillments",
    "id",
    [
      { op: "notNull", column: "shipped_at" },
      { op: "gte", column: "shipped_at", value: iso(nowMs - 45 * DAY_MS) },
      { op: "lte", column: "shipped_at", value: iso(nowMs - 7 * DAY_MS) },
    ],
  );
  if (rows.length === 0) {
    return measured(0, { detail: { shippedInWindow: 0 } });
  }
  const ids = rows.map((r) => r.id);
  const billed = new Set<string>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    const { data, error } = (await db
      .from("insurance_claims")
      .select("fulfillment_id")
      .in("fulfillment_id", chunk)) as unknown as {
      data: Array<{ fulfillment_id: string | null }> | null;
      error: unknown;
    };
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.fulfillment_id) billed.add(row.fulfillment_id);
    }
  }
  return measured(ids.length - billed.size, {
    sample: ids.length,
    truncated,
    detail: {
      shippedInWindow: ids.length,
      billed: billed.size,
      windowDays: "7-45",
    },
  });
}

// ── Billing ──────────────────────────────────────────────────────────

async function collectStuckSubmitting(db: Db, nowMs: number) {
  const value = await countWhere(db, "insurance_claims", [
    { op: "eq", column: "status", value: "submitting" },
    { op: "lt", column: "updated_at", value: iso(nowMs - 2 * HOUR_MS) },
  ]);
  return measured(value, { detail: { stuckForHours: 2 } });
}

async function collectClaimsMissingEvidence(
  db: Db,
  orgId: string,
  nowMs: number,
) {
  const required = await readCutoverFlagState(
    orgId,
    "resupply.ship_evidence_required",
  );
  if (!required) {
    return {
      state: "disabled" as const,
      value: null,
      reason:
        "This tenant does not require shipment evidence before billing, so a claim without it is not a violation here. Enable the flag from the cutover workflow once the readiness assessment passes.",
    };
  }

  const { rows, truncated } = await fetchRows<{
    id: string;
    fulfillment_id: string | null;
  }>(db, "insurance_claims", "id,fulfillment_id", [
    { op: "gte", column: "created_at", value: iso(nowMs - 30 * DAY_MS) },
  ]);
  if (rows.length === 0) return measured(0, { detail: { claimsInWindow: 0 } });

  // A claim with no fulfillment at all has no shipment behind it by
  // definition, and is the worse version of this problem.
  let missing = rows.filter((r) => !r.fulfillment_id).length;
  const ids = rows
    .map((r) => r.fulfillment_id)
    .filter((id): id is string => Boolean(id));

  const shipped = new Set<string>();
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    const { data, error } = (await db
      .from("fulfillments")
      .select("id")
      .in("id", chunk)
      .not("shipped_at", "is", null)) as unknown as {
      data: Array<{ id: string }> | null;
      error: unknown;
    };
    if (error) throw error;
    for (const row of data ?? []) shipped.add(row.id);
  }
  missing += ids.filter((id) => !shipped.has(id)).length;

  return measured(missing, {
    sample: rows.length,
    truncated,
    detail: {
      claimsInWindow: rows.length,
      withoutFulfillment: rows.filter((r) => !r.fulfillment_id).length,
    },
  });
}

/** Statuses that mean the claim reached the clearinghouse at all. */
const SUBMITTED_ONWARD = [
  "submitted",
  "accepted",
  "denied",
  "rejected",
  "partially_paid",
  "paid",
  "appealed",
  "closed",
] as const;

/** …and that a payer actually adjudicated it. */
const ADJUDICATED = ["accepted", "denied", "partially_paid", "paid"] as const;

async function collectRejectionRate(db: Db, nowMs: number) {
  const since = iso(nowMs - 30 * DAY_MS);
  const denominator = await countWhere(db, "insurance_claims", [
    { op: "in", column: "status", values: SUBMITTED_ONWARD },
    { op: "gte", column: "created_at", value: since },
  ]);
  const rejected = await countWhere(db, "insurance_claims", [
    { op: "eq", column: "status", value: "rejected" },
    { op: "gte", column: "created_at", value: since },
  ]);
  return measured(denominator > 0 ? rejected / denominator : 0, {
    sample: denominator,
    detail: { rejected, submitted: denominator, windowDays: 30 },
  });
}

async function collectDenialRate(db: Db, nowMs: number) {
  const since = iso(nowMs - 30 * DAY_MS);
  const denominator = await countWhere(db, "insurance_claims", [
    { op: "in", column: "status", values: ADJUDICATED },
    { op: "gte", column: "created_at", value: since },
  ]);
  const denied = await countWhere(db, "insurance_claims", [
    { op: "eq", column: "status", value: "denied" },
    { op: "gte", column: "created_at", value: since },
  ]);
  return measured(denominator > 0 ? denied / denominator : 0, {
    sample: denominator,
    detail: { denied, adjudicated: denominator, windowDays: 30 },
  });
}

// ── PacWare shipment imports ─────────────────────────────────────────

interface ImportRow {
  dispositions: Record<string, number> | null;
  created_at: string;
}

/**
 * The three PacWare signals off ONE read of the newest committed import.
 *
 * Preview-mode imports are excluded: a preview is somebody checking a
 * file, and alerting on a check would punish exactly the careful
 * behaviour the preview mode exists to encourage.
 */
export async function collectPacwareObservations(
  db: Db,
  nowMs: number,
): Promise<Observations> {
  const keys = [
    "pacware_unmatched_rows",
    "pacware_ambiguous_rows",
    "pacware_invalid_dates",
  ];
  try {
    const { rows } = await fetchRowsNewest<ImportRow>(
      db,
      "pacware_shipment_imports",
      "dispositions,created_at",
      [{ op: "eq", column: "mode", value: "commit" }],
      "created_at",
    );
    const latest = rows[0];
    if (!latest) {
      const none: SignalObservation = {
        state: "not_configured",
        value: null,
        reason:
          "No shipment-confirmation file has ever been imported for this tenant. That is not the same as an import with no problems — until a feed exists, shipments are invisible to this system.",
      };
      return Object.fromEntries(keys.map((k) => [k, none]));
    }
    const d = latest.dispositions ?? {};
    const n = (key: string) => Number(d[key] ?? 0) || 0;
    const importedAgo = hoursSince(latest.created_at, nowMs);
    const detail = {
      lastImportHoursAgo:
        importedAgo === null ? null : Math.round(importedAgo * 10) / 10,
    };
    return {
      pacware_unmatched_rows: measured(n("unmatched"), { detail }),
      pacware_ambiguous_rows: measured(n("ambiguous"), { detail }),
      pacware_invalid_dates: measured(
        n("invalid") + n("too_old") + n("future_dated"),
        {
          detail: {
            ...detail,
            invalid: n("invalid"),
            tooOld: n("too_old"),
            futureDated: n("future_dated"),
          },
        },
      ),
    };
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_health.collector_failed",
        signal: "pacware_imports",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: the PacWare import read failed",
    );
    const failed: SignalObservation = {
      state: "unknown",
      value: null,
      reason: "The shipment-import read failed. This is not a zero.",
    };
    return Object.fromEntries(keys.map((k) => [k, failed]));
  }
}

// ── Integrations ─────────────────────────────────────────────────────

interface ConnectorRow {
  source: string;
  status: string;
  last_sync_success_at: string | null;
  consecutive_failures: number;
  partial_resources: unknown;
}

interface ReconRow {
  source: string;
  created_at: string;
  missing_locally_count: number;
  missing_in_portal_count: number;
  mismatched_count: number;
}

/**
 * Four integration signals off two small reads.
 *
 * Owns its own failure fan-out: a connector table that will not read
 * makes all four signals unknown, not three unknown and one accidentally
 * zero. That asymmetry is how a broken integrations table turns into a
 * green "0 partial responses" badge.
 */
export async function collectConnectorObservations(
  db: Db,
  nowMs: number,
): Promise<Observations> {
  const keys = [
    "connector_failures",
    "connector_partial_responses",
    "therapy_data_staleness",
    "portal_reconciliation_discrepancies",
  ];
  try {
    return await readConnectorObservations(db, nowMs);
  } catch (err) {
    logger.warn(
      {
        event: "lifecycle_health.collector_failed",
        signal: "connector_status",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "lifecycle-health: the connector-status read failed",
    );
    const failed: SignalObservation = {
      state: "unknown",
      value: null,
      reason: "The connector-status read failed. This is not a zero.",
    };
    return Object.fromEntries(keys.map((k) => [k, failed]));
  }
}

async function readConnectorObservations(
  db: Db,
  nowMs: number,
): Promise<Observations> {
  const { data, error } = (await db
    .from("integration_connector_status")
    .select(
      "source,status,last_sync_success_at,consecutive_failures,partial_resources",
    )) as unknown as { data: ConnectorRow[] | null; error: unknown };
  if (error) throw error;
  const allRows = data ?? [];

  // A ROW IS NOT A CONNECTOR.
  //
  // `integration_connector_status` keeps a row per source the tenant has
  // ever touched, and two of its statuses are positive statements that
  // there is nothing to measure: `not_configured` (this tenant has no
  // credentials for that vendor) and `disabled` (somebody switched it
  // off deliberately). Counting them made the emptiness check below
  // unreachable for any tenant that had ever opened the integrations
  // page — so a tenant with three unconfigured connectors reported
  // `connector_failures: 0` as a MEASURED healthy number, and
  // `therapy_data_staleness` announced that "a connector is configured
  // but no sync has ever succeeded", which was not true of any of them.
  const connectors = allRows.filter(
    (c) => c.status !== "not_configured" && c.status !== "disabled",
  );
  const inactive = allRows.length - connectors.length;

  const notConfigured = (what: string): SignalObservation => ({
    state: "not_configured",
    value: null,
    reason: what,
  });

  const out: Observations = {};

  if (connectors.length === 0) {
    const reason =
      allRows.length === 0
        ? "No therapy connector is configured for this tenant. A tenant with no connector has no failures and no device data either, and those must not render the same."
        : `This tenant has ${allRows.length} connector row(s), and every one of them is unconfigured or switched off. That is not a healthy zero — there is nothing running to be healthy.`;
    out.connector_failures = notConfigured(reason);
    out.connector_partial_responses = notConfigured(reason);
    out.therapy_data_staleness = notConfigured(reason);
  } else {
    out.connector_failures = measured(
      Math.max(...connectors.map((c) => Number(c.consecutive_failures) || 0)),
      {
        sample: connectors.length,
        detail: { connectors: connectors.length, inactive },
      },
    );

    const partial = connectors.filter((c) => {
      const p = c.partial_resources;
      if (Array.isArray(p)) return p.length > 0;
      if (p && typeof p === "object") return Object.keys(p).length > 0;
      return false;
    });
    out.connector_partial_responses = measured(partial.length, {
      sample: connectors.length,
      detail: { sources: partial.map((c) => c.source).join(", ") || "none" },
    });

    const lastSuccess = connectors
      .map((c) =>
        c.last_sync_success_at ? Date.parse(c.last_sync_success_at) : NaN,
      )
      .filter((t) => Number.isFinite(t));
    out.therapy_data_staleness =
      lastSuccess.length === 0
        ? notConfigured(
            "A connector is configured but no sync has ever succeeded, so there is no data to be stale. The connector-failure signal is the one to read.",
          )
        : measured(Math.max(0, (nowMs - Math.max(...lastSuccess)) / HOUR_MS), {
            sample: connectors.length,
          });
  }

  // Reconciliation: the newest run PER SOURCE. A single global "latest"
  // would let one source's fresh run hide another's stale one.
  const { data: reconData, error: reconError } = (await db
    .from("integration_reconciliation_runs")
    .select(
      "source,created_at,missing_locally_count,missing_in_portal_count,mismatched_count",
    )
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(50)) as unknown as { data: ReconRow[] | null; error: unknown };
  if (reconError) throw reconError;
  const runs = reconData ?? [];
  if (runs.length === 0) {
    out.portal_reconciliation_discrepancies = notConfigured(
      "No portal reconciliation has ever been run for this tenant. Never having checked is not the same as having checked and found nothing.",
    );
  } else {
    const newestPerSource = new Map<string, ReconRow>();
    for (const run of runs) {
      if (!newestPerSource.has(run.source))
        newestPerSource.set(run.source, run);
    }
    let total = 0;
    for (const run of newestPerSource.values()) {
      total +=
        (Number(run.missing_locally_count) || 0) +
        (Number(run.missing_in_portal_count) || 0) +
        (Number(run.mismatched_count) || 0);
    }
    out.portal_reconciliation_discrepancies = measured(total, {
      sample: newestPerSource.size,
      detail: { sourcesReconciled: newestPerSource.size },
    });
  }

  return out;
}

// ── Tenancy + platform machinery ─────────────────────────────────────

async function collectFlagsWithoutEvidence(orgId: string, nowMs: number) {
  const now = new Date(nowMs);
  const offenders: string[] = [];
  for (const flagKey of CUTOVER_FLAG_KEYS) {
    const enabled = await readCutoverFlagState(orgId, flagKey);
    if (!enabled) continue;
    const { ok, state } = await hasFreshReadyAssessment(orgId, flagKey, now);
    if (!ok) offenders.push(`${flagKey} (${state})`);
  }
  return measured(offenders.length, {
    detail: { flags: offenders.join("; ") || "none" },
  });
}

async function collectApprovalQueuesPastSla(db: Db, nowMs: number) {
  const multiplier = escalationMultiplier();
  const gates = APPROVAL_GATES.filter((g) => g.queue && g.slaHours !== null);
  const readings = await Promise.all(gates.map((g) => readGate(db, g)));
  let breached = 0;
  let unreadable = 0;
  const names: string[] = [];
  gates.forEach((gate, i) => {
    const reading = readings[i];
    if (reading.failed) {
      unreadable += 1;
      return;
    }
    const age = ageStatus(gate.slaHours, reading.oldestAt, nowMs, multiplier);
    if (age.status === "breached" || age.status === "escalate") {
      breached += 1;
      names.push(gate.key);
    }
  });
  // An unreadable queue makes the count a floor, not a total — the same
  // honesty the panel itself applies to a failed gate read.
  return measured(breached, {
    sample: gates.length,
    truncated: unreadable > 0,
    detail: {
      queues: names.join(", ") || "none",
      unreadableQueues: unreadable,
    },
  });
}

// ── Platform-scope signals ───────────────────────────────────────────

/**
 * Signals about rows that belong to NO tenant.
 *
 * Evaluated once per scan, never per tenant: showing the same global
 * number inside every practice's panel would have each operator chasing
 * another's problem.
 */
export async function collectPlatformObservations(
  options: CollectOptions & { seedOrgId: string },
): Promise<Observations> {
  const nowMs = options.nowMs ?? Date.now();
  const raw = getOrgScopedClient(options.seedOrgId).raw();
  const since = iso(nowMs - 7 * DAY_MS);

  const out: Observations = {};

  out.voice_calls_unattributed = await safely(
    "voice_calls_unattributed",
    async () => {
      // raw-org-scope-exempt: this counts rows whose org_id is NULL —
      // calls that belong to no tenant at all. An org filter would by
      // construction return zero, which is exactly the blind spot this
      // signal exists to remove. Reports a COUNT to the platform
      // operator; no row, id or number is read.
      const { count, error } = (await raw
        .schema("resupply")
        .from("voice_calls")
        .select("*", { count: "exact", head: true })
        .is("org_id", null)
        .gte("created_at", since)) as unknown as {
        count: number | null;
        error: unknown;
      };
      if (error) throw error;
      return measured(count ?? 0, { detail: { windowDays: 7 } });
    },
  );

  out.inbound_attribution_failures = await safely(
    "inbound_attribution_failures",
    async () => {
      // raw-org-scope-exempt: `inbound_attribution_failures` has no
      // org_id and cannot have one — attribution is precisely what
      // failed. It is a day/channel/reason rollup with no identifiers in
      // it, read here as a platform-wide total.
      const { data, error } = (await raw
        .schema("resupply")
        .from("inbound_attribution_failures")
        .select("channel,reason,failures")
        .gte("day", iso(nowMs - 7 * DAY_MS).slice(0, 10))) as unknown as {
        data: Array<{
          channel: string;
          reason: string;
          failures: number;
        }> | null;
        error: unknown;
      };
      if (error) throw error;
      const rows = data ?? [];
      const total = rows.reduce((sum, r) => sum + (Number(r.failures) || 0), 0);
      const byReason = new Map<string, number>();
      for (const row of rows) {
        byReason.set(
          row.reason,
          (byReason.get(row.reason) ?? 0) + (Number(row.failures) || 0),
        );
      }
      return measured(total, {
        detail: {
          windowDays: 7,
          reasons:
            [...byReason.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason, n]) => `${reason}=${n}`)
              .join(", ") || "none",
        },
      });
    },
  );

  return out;
}

/** Every signal key the catalog defines, for completeness assertions. */
export const ALL_SIGNAL_KEYS: readonly string[] = LIFECYCLE_SIGNALS.map(
  (s) => s.key,
);
