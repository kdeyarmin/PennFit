// Pure aggregation for the platform super-admin analytics dashboard
// (/platform/analytics). The route does the DB fan-out and hands the
// raw per-tenant arrays here; everything below is a pure, unit-tested
// function so the day-bucketing / delta math stays free of I/O.
//
// PII posture mirrors the rest of the platform surface: aggregate counts
// and dollar rollups ONLY — no patient rows ever reach this module. The
// route selects nothing but timestamps + order amounts.
//
// Time is bucketed in UTC. A tenant-scoped admin sees its own day
// boundaries; the cross-tenant fleet view standardises on UTC so the
// series is stable regardless of where the operator sits.

const DAY_MS = 86_400_000;

/** UTC `YYYY-MM-DD` for an epoch-ms instant. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The ordered list of UTC day keys for the trailing `days`-day window
 * ending on `nowMs`'s UTC day (oldest first, newest = today).
 */
export function windowDayKeys(nowMs: number, days: number): string[] {
  const now = new Date(nowMs);
  const endDayStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(utcDayKey(endDayStart - i * DAY_MS));
  }
  return keys;
}

/** Count ISO timestamps into the day buckets named by `dayKeys`. Anything
 *  outside the window is ignored. */
export function bucketCountByDay(
  isoTimestamps: ReadonlyArray<string>,
  dayKeys: ReadonlyArray<string>,
): number[] {
  const index = new Map(dayKeys.map((k, i) => [k, i] as const));
  const out = new Array<number>(dayKeys.length).fill(0);
  for (const iso of isoTimestamps) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    const i = index.get(utcDayKey(ms));
    if (i !== undefined) out[i] += 1;
  }
  return out;
}

/** Sum `{ iso, cents }` entries into the day buckets named by `dayKeys`. */
export function bucketSumByDay(
  entries: ReadonlyArray<{ iso: string; cents: number }>,
  dayKeys: ReadonlyArray<string>,
): number[] {
  const index = new Map(dayKeys.map((k, i) => [k, i] as const));
  const out = new Array<number>(dayKeys.length).fill(0);
  for (const { iso, cents } of entries) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    const i = index.get(utcDayKey(ms));
    if (i !== undefined) out[i] += cents;
  }
  return out;
}

/**
 * Percentage change current-vs-prior, rounded to one decimal. Returns
 * `null` when the prior window was zero (an honest "no baseline" instead
 * of a fabricated +∞ / +100%).
 */
export function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10;
}

// ── Input / output shapes ───────────────────────────────────────────

/** One order row, narrowed to the fields analytics needs. */
export interface AnalyticsOrder {
  createdAt: string;
  /** `paid_at` — null for unpaid/abandoned checkouts. GMV counts only
   *  paid orders, keyed by when they were paid. */
  paidAt: string | null;
  amountCents: number;
  refundedCents: number;
}

export interface AnalyticsTenantInput {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  createdAt: string;
  /** All-time headline counts (HEAD counts). `null` when the count failed. */
  allTime: {
    patients: number | null;
    orders: number | null;
    conversations: number | null;
  };
  /** `created_at` of patients within the (2× window) fetch. */
  patientCreatedAt: string[];
  /** Orders within the (2× window) fetch. */
  orders: AnalyticsOrder[];
  /** `created_at` of conversations within the (2× window) fetch. */
  conversationCreatedAt: string[];
}

export interface PlatformAnalyticsInput {
  nowMs: number;
  days: number;
  tenants: AnalyticsTenantInput[];
}

export interface PlatformAnalyticsTenantRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  createdAt: string;
  patients: number | null;
  orders: number | null;
  conversations: number | null;
  windowNewPatients: number;
  windowOrders: number;
  windowGmvCents: number;
}

export interface PlatformAnalyticsResult {
  windowDays: number;
  dayKeys: string[];
  totals: {
    tenants: {
      total: number;
      active: number;
      suspended: number;
      archived: number;
    };
    patients: number | null;
    orders: number | null;
    conversations: number | null;
  };
  window: {
    newTenants: number;
    newPatients: number;
    newOrders: number;
    newConversations: number;
    gmvCents: number;
    delta: {
      newPatients: number | null;
      newOrders: number | null;
      newConversations: number | null;
      gmvCents: number | null;
    };
  };
  series: {
    newTenants: number[];
    newPatients: number[];
    newOrders: number[];
    newConversations: number[];
    gmvCents: number[];
  };
  tenants: PlatformAnalyticsTenantRow[];
}

/** Sum a list of maybe-null counts: `null` only when EVERY entry is null
 *  (so "all counts failed" stays distinguishable from "genuinely zero"). */
function sumOrNull(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  let sawNumber = false;
  for (const v of values) {
    if (v != null) {
      sum += v;
      sawNumber = true;
    }
  }
  return sawNumber ? sum : null;
}

/** Sum of a numeric bucket array. */
function sumOf(values: ReadonlyArray<number>): number {
  let n = 0;
  for (const v of values) n += v;
  return n;
}

/**
 * The `days` UTC day keys immediately PRECEDING `currentKeys` (the prior
 * comparison window). Anchored to the same UTC day starts as
 * `windowDayKeys` so current/prior windows tile the calendar exactly —
 * no rolling mid-day cutoff that could let window totals drift from the
 * day-bucketed series.
 */
function priorWindowKeys(
  currentKeys: ReadonlyArray<string>,
  days: number,
): string[] {
  if (currentKeys.length === 0) return [];
  const firstDayStartMs = Date.parse(`${currentKeys[0]}T00:00:00.000Z`);
  return windowDayKeys(firstDayStartMs - DAY_MS, days);
}

/** Paid-order entries `{ iso: paid_at, cents: net }` — orders count and
 *  GMV are both keyed on payment, so they share one axis and a pending /
 *  abandoned checkout (no `paid_at`) contributes to neither. */
function paidOrderEntries(
  orders: ReadonlyArray<AnalyticsOrder>,
): Array<{ iso: string; cents: number }> {
  const out: Array<{ iso: string; cents: number }> = [];
  for (const o of orders) {
    if (!o.paidAt) continue;
    out.push({ iso: o.paidAt, cents: o.amountCents - o.refundedCents });
  }
  return out;
}

/**
 * Fold the per-tenant raw arrays into the dashboard payload: fleet
 * totals, current-vs-prior window deltas, daily trend series, and a
 * per-tenant leaderboard. Pure — `nowMs` is injected so tests are
 * deterministic.
 *
 * Current/prior windows are UTC-day-aligned with the series buckets, so
 * `window.<metric>` always equals `sum(series.<metric>)`. "Orders" means
 * PAID orders (keyed on `paid_at`), consistent with GMV.
 */
export function aggregatePlatformAnalytics(
  input: PlatformAnalyticsInput,
): PlatformAnalyticsResult {
  const { nowMs, days, tenants } = input;
  const dayKeys = windowDayKeys(nowMs, days);
  const priorKeys = priorWindowKeys(dayKeys, days);

  // Fleet trend series (current window) — summed across tenants.
  const newTenants = new Array<number>(dayKeys.length).fill(0);
  const newPatients = new Array<number>(dayKeys.length).fill(0);
  const newOrders = new Array<number>(dayKeys.length).fill(0);
  const newConversations = new Array<number>(dayKeys.length).fill(0);
  const gmvCents = new Array<number>(dayKeys.length).fill(0);

  const addInto = (acc: number[], add: ReadonlyArray<number>): void => {
    for (let i = 0; i < acc.length; i++) acc[i] += add[i] ?? 0;
  };

  const statusTotals = { total: 0, active: 0, suspended: 0, archived: 0 };
  let priorPatients = 0;
  let priorOrders = 0;
  let priorConversations = 0;
  let priorGmv = 0;

  const tenantRows: PlatformAnalyticsTenantRow[] = tenants.map((t) => {
    statusTotals.total += 1;
    if (t.status === "active") statusTotals.active += 1;
    else if (t.status === "suspended") statusTotals.suspended += 1;
    else if (t.status === "archived") statusTotals.archived += 1;

    const paidEntries = paidOrderEntries(t.orders);
    const paidIsos = paidEntries.map((e) => e.iso);

    // Current-window day buckets for this tenant.
    const tPatients = bucketCountByDay(t.patientCreatedAt, dayKeys);
    const tOrders = bucketCountByDay(paidIsos, dayKeys);
    const tConversations = bucketCountByDay(t.conversationCreatedAt, dayKeys);
    const tGmv = bucketSumByDay(paidEntries, dayKeys);

    addInto(newPatients, tPatients);
    addInto(newOrders, tOrders);
    addInto(newConversations, tConversations);
    addInto(gmvCents, tGmv);
    addInto(newTenants, bucketCountByDay([t.createdAt], dayKeys));

    // Prior-window totals (for the deltas), same day-aligned bucketing.
    priorPatients += sumOf(bucketCountByDay(t.patientCreatedAt, priorKeys));
    priorOrders += sumOf(bucketCountByDay(paidIsos, priorKeys));
    priorConversations += sumOf(
      bucketCountByDay(t.conversationCreatedAt, priorKeys),
    );
    priorGmv += sumOf(bucketSumByDay(paidEntries, priorKeys));

    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status,
      createdAt: t.createdAt,
      patients: t.allTime.patients,
      orders: t.allTime.orders,
      conversations: t.allTime.conversations,
      windowNewPatients: sumOf(tPatients),
      windowOrders: sumOf(tOrders),
      windowGmvCents: sumOf(tGmv),
    };
  });

  // Window totals == series sums by construction (same day buckets).
  const winNewTenants = sumOf(newTenants);
  const winNewPatients = sumOf(newPatients);
  const winNewOrders = sumOf(newOrders);
  const winNewConversations = sumOf(newConversations);
  const winGmv = sumOf(gmvCents);

  // Leaderboard: biggest contributors first (GMV, then order volume).
  tenantRows.sort(
    (a, b) =>
      b.windowGmvCents - a.windowGmvCents || b.windowOrders - a.windowOrders,
  );

  return {
    windowDays: days,
    dayKeys,
    totals: {
      tenants: statusTotals,
      patients: sumOrNull(tenants.map((t) => t.allTime.patients)),
      orders: sumOrNull(tenants.map((t) => t.allTime.orders)),
      conversations: sumOrNull(tenants.map((t) => t.allTime.conversations)),
    },
    window: {
      newTenants: winNewTenants,
      newPatients: winNewPatients,
      newOrders: winNewOrders,
      newConversations: winNewConversations,
      gmvCents: winGmv,
      delta: {
        newPatients: pctChange(winNewPatients, priorPatients),
        newOrders: pctChange(winNewOrders, priorOrders),
        newConversations: pctChange(winNewConversations, priorConversations),
        gmvCents: pctChange(winGmv, priorGmv),
      },
    },
    series: {
      newTenants,
      newPatients,
      newOrders,
      newConversations,
      gmvCents,
    },
    tenants: tenantRows,
  };
}
