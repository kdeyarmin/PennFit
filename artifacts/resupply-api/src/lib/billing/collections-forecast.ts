// AR collections forecast (Owner #4, slice 1).
//
// "Money in flight": project expected cash collections from outstanding
// insurance claims — claims we've submitted/accepted but the payer
// hasn't paid yet — bucketed by when we expect each to land. This is the
// claims half of the revenue/cash-flow projection; the forward resupply
// order book (next-eligible-date × confirm rate) is slice 2.
//
// The model is deliberately simple and HONEST about its assumptions
// (every rate is configurable and echoed back in the response) rather
// than pretending to a precision the data can't support:
//
//   expected_collectible = allowed_cents      (when the payer has
//                          adjudicated an allowed amount)
//                        = billed_cents × defaultAllowedRatio  (else —
//                          billed is sticker price, not what we collect)
//   expected_cash        = expected_collectible × collectionProbability
//   lands_in_days        = max(0, expectedDaysToPay − ageDays)
//
// Pure — no I/O. Unit-tested directly.

/** Claim statuses that represent money we're still expecting. */
export const OUTSTANDING_AR_STATUSES = ["submitted", "accepted"] as const;

export interface OutstandingClaim {
  status: string;
  total_billed_cents: number;
  total_allowed_cents: number;
  submitted_at: string | null;
}

export interface ForecastOpts {
  asOf?: string;
  /** Typical submit→pay span. Default 45 days. */
  expectedDaysToPay?: number;
  /** When the payer hasn't set an allowed amount yet, estimate it as
   *  billed × this. Conservative default 0.5 (billed ≫ allowed for DME). */
  defaultAllowedRatio?: number;
  /** Share of the allowed amount we actually collect. Default 0.95. */
  collectionProbability?: number;
}

export interface ForecastHorizon {
  label: string;
  /** Upper bound (inclusive) in days from asOf; Infinity for the tail. */
  withinDays: number;
  expectedCents: number;
  claimCount: number;
}

export interface CollectionsForecast {
  horizons: ForecastHorizon[];
  totalExpectedCents: number;
  outstandingClaimCount: number;
  /** Sum of expected cash across all claims (== total of the horizons). */
  grossExpectedCents: number;
  assumptions: {
    expectedDaysToPay: number;
    defaultAllowedRatio: number;
    collectionProbability: number;
    asOf: string;
  };
}

const DAY_MS = 86_400_000;

const HORIZON_BOUNDS: ReadonlyArray<{ label: string; withinDays: number }> = [
  { label: "≤30 days", withinDays: 30 },
  { label: "31–60 days", withinDays: 60 },
  { label: "61–90 days", withinDays: 90 },
  { label: ">90 days", withinDays: Number.POSITIVE_INFINITY },
];

function ageDays(submittedAt: string | null, asOfMs: number): number {
  if (!submittedAt) return 0;
  const ms = Date.parse(submittedAt);
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((asOfMs - ms) / DAY_MS));
}

/**
 * Pure: project expected cash collections from a set of outstanding
 * claims, bucketed into non-overlapping horizon windows. Claims with a
 * non-outstanding status are ignored (caller normally pre-filters, but
 * we guard anyway). Money in integer cents.
 */
export function projectClaimCollections(
  claims: readonly OutstandingClaim[],
  opts: ForecastOpts = {},
): CollectionsForecast {
  const expectedDaysToPay = opts.expectedDaysToPay ?? 45;
  const defaultAllowedRatio = opts.defaultAllowedRatio ?? 0.5;
  const collectionProbability = opts.collectionProbability ?? 0.95;
  const asOfMs = opts.asOf ? Date.parse(opts.asOf) : Date.now();
  const baseMs = Number.isNaN(asOfMs) ? Date.now() : asOfMs;
  const asOfIso = new Date(baseMs).toISOString();

  const horizons: ForecastHorizon[] = HORIZON_BOUNDS.map((h) => ({
    label: h.label,
    withinDays: h.withinDays,
    expectedCents: 0,
    claimCount: 0,
  }));

  let total = 0;
  let count = 0;

  const outstanding = new Set<string>(OUTSTANDING_AR_STATUSES);
  for (const c of claims) {
    if (!outstanding.has(c.status)) continue;
    count += 1;

    const billed = Math.max(0, c.total_billed_cents ?? 0);
    const allowed = Math.max(0, c.total_allowed_cents ?? 0);
    const collectible =
      allowed > 0 ? allowed : Math.round(billed * defaultAllowedRatio);
    const expected = Math.round(collectible * collectionProbability);

    const landsInDays = Math.max(
      0,
      expectedDaysToPay - ageDays(c.submitted_at, baseMs),
    );
    const horizon =
      horizons.find((h) => landsInDays <= h.withinDays) ??
      horizons[horizons.length - 1]!;
    horizon.expectedCents += expected;
    horizon.claimCount += 1;
    total += expected;
  }

  return {
    horizons,
    totalExpectedCents: total,
    outstandingClaimCount: count,
    grossExpectedCents: total,
    assumptions: {
      expectedDaysToPay,
      defaultAllowedRatio,
      collectionProbability,
      asOf: asOfIso,
    },
  };
}
