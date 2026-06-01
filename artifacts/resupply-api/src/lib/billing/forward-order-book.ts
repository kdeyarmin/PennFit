// Forward resupply order book (Owner #4, slice 2).
//
// The other half of the revenue forecast: expected NEW resupply revenue
// from patients becoming resupply-eligible in the coming weeks. Eligible
// date is real — last fulfillment + the prescription's cadence_days (the
// same anchor the reminder dispatcher uses). Only two numbers are
// assumptions, both surfaced + tunable: the expected per-order value and
// the confirm rate (what fraction of eligible patients actually reorder;
// the roadmap flags this as needing history to calibrate, so it defaults
// conservative and is labeled an estimate). Pure — no I/O, unit-tested.

export interface DuePrescription {
  /** Most recent fulfillment date for this patient+SKU (null = never). */
  lastFillIso: string | null;
  /** Resupply cadence in days (prescriptions.cadence_days). */
  cadenceDays: number;
}

export interface OrderBookOpts {
  asOf?: string;
  /** Overall look-ahead window. Default 90 days. */
  horizonDays?: number;
  /** Expected revenue per resupply order. Default $80. */
  expectedOrderValueCents?: number;
  /** Fraction of eligible patients expected to reorder. Default 0.55. */
  confirmRate?: number;
}

export interface OrderBookHorizon {
  label: string;
  withinDays: number;
  dueCount: number;
  expectedCents: number;
}

export interface ForwardOrderBook {
  horizons: OrderBookHorizon[];
  totalExpectedCents: number;
  dueCount: number;
  assumptions: {
    expectedOrderValueCents: number;
    confirmRate: number;
    horizonDays: number;
    asOf: string;
  };
}

const DAY_MS = 86_400_000;

const HORIZON_BOUNDS: ReadonlyArray<{ label: string; withinDays: number }> = [
  { label: "≤30 days", withinDays: 30 },
  { label: "31–60 days", withinDays: 60 },
  { label: "61–90 days", withinDays: 90 },
];

/**
 * Pure: project expected resupply revenue from prescriptions becoming
 * eligible within the horizon. A prescription with no fulfillment yet has
 * no resupply baseline and is skipped (that's a pending initial order,
 * not a resupply). Overdue prescriptions (eligible date already past) are
 * expected to reorder imminently → counted in the nearest bucket.
 */
export function projectForwardOrderBook(
  prescriptions: readonly DuePrescription[],
  opts: OrderBookOpts = {},
): ForwardOrderBook {
  const horizonDays = opts.horizonDays ?? 90;
  const expectedOrderValueCents = opts.expectedOrderValueCents ?? 8000;
  const confirmRate = opts.confirmRate ?? 0.55;
  const asOfMs = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  const baseMs = Number.isNaN(asOfMs) ? Date.now() : asOfMs;
  const asOfIso = new Date(baseMs).toISOString();

  const bounds = HORIZON_BOUNDS.filter((h) => h.withinDays <= horizonDays);
  const horizons: OrderBookHorizon[] = bounds.map((h) => ({
    label: h.label,
    withinDays: h.withinDays,
    dueCount: 0,
    expectedCents: 0,
  }));

  const perOrder = Math.round(expectedOrderValueCents * confirmRate);
  let dueCount = 0;

  for (const p of prescriptions) {
    if (!p.lastFillIso) continue;
    const lastMs = Date.parse(p.lastFillIso);
    if (Number.isNaN(lastMs)) continue;
    if (!Number.isFinite(p.cadenceDays) || p.cadenceDays <= 0) continue;

    const nextEligibleMs = lastMs + p.cadenceDays * DAY_MS;
    const daysUntil = Math.floor((nextEligibleMs - baseMs) / DAY_MS);
    if (daysUntil > horizonDays) continue; // not due within the window

    const effectiveDays = Math.max(0, daysUntil); // overdue → due now
    const horizon = horizons.find((h) => effectiveDays <= h.withinDays);
    if (!horizon) continue;
    horizon.dueCount += 1;
    horizon.expectedCents += perOrder;
    dueCount += 1;
  }

  return {
    horizons,
    totalExpectedCents: horizons.reduce((s, h) => s + h.expectedCents, 0),
    dueCount,
    assumptions: {
      expectedOrderValueCents,
      confirmRate,
      horizonDays,
      asOf: asOfIso,
    },
  };
}
