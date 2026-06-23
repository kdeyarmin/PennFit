// resolveResupplyEntitlement — decides whether a resupply dispense of a
// given supply family (HCPCS) is *payable* right now for one patient,
// and if not, when it next will be.
//
// Why this lives in @workspace/resupply-domain:
//   Like resolveOutreachPlan, the decision is pure — no DB, no clock
//   except what's passed in, no network (ADR 008). The worker, the
//   order/confirm route ("can this patient reorder now?"), and the
//   admin "why is this blocked?" preview all share this one function.
//
// What it models
// --------------
// Medicare LCD L33718 (and most commercial DME contracts) pay for a
// replacement supply only when BOTH hold:
//
//   1. INTERVAL — at least `minIntervalDays` have elapsed since the
//      last payable dispense of this code. Ordering earlier is the
//      single most common avoidable DME denial ("too soon"), and the
//      patient eats the whole cost. This guard catches it BEFORE we
//      ship, not weeks later on the remittance.
//
//   2. QUANTITY — the dispense would not push the patient over
//      `maxQuantityPerPeriod` within the rolling `periodDays` window
//      (e.g. two A7032 nasal cushions per 30 days).
//
// The two gates are independent. `eligible` is their conjunction.
//
// A note on the quantity date
// ----------------------------
// We can compute the exact date the INTERVAL gate clears
// (`eligibleOn`), but not the date the QUANTITY gate clears: that
// depends on when the earliest dispense in the current period rolls
// off, and this pure function is given only the *count* already
// dispensed in the period, not their individual dates. So
// `daysUntilEligible` always reflects the interval gate; when quantity
// is the binding constraint, `status` and `reason` say so explicitly.

export const ENTITLEMENT_STATUSES = [
  "eligible",
  "too_soon",
  "quantity_exceeded",
] as const;
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

export interface ResupplyEntitlementInput {
  /** When this HCPCS / supply family was last dispensed to the patient.
   *  `null` means never dispensed → the interval gate is open. */
  lastFulfilledAt: Date | null;
  /** Minimum days between payable dispenses
   *  (resupply.hcpcs_codes.min_interval_days). */
  minIntervalDays: number;
  /** Max payable quantity within `periodDays`
   *  (resupply.hcpcs_codes.max_quantity_per_period). */
  maxQuantityPerPeriod: number;
  /** Rolling window the quantity cap applies over
   *  (resupply.hcpcs_codes.period_days). */
  periodDays: number;
  /** Quantity already dispensed within the current rolling period.
   *  Clamped to >= 0 defensively. */
  quantityInPeriod: number;
  /** Quantity being requested now. Defaults to 1. */
  requestedQuantity?: number;
  /** Optional early-ship grace, in days, that opens the INTERVAL gate
   *  sooner so entitlement and the refill ship-window
   *  (`REFILL_SHIP_LEAD_DAYS`) don't disagree on whether an early ship is
   *  allowed. The effective interval becomes
   *  `max(0, minIntervalDays - graceDays)`. Defaults to 0 (no grace).
   *  Clamped to a finite, non-negative value. */
  graceDays?: number;
  /** Optional timestamp of the EARLIEST dispense still inside the current
   *  rolling `periodDays` window. When supplied, the quantity gate can
   *  report `quantityEligibleOn` — the date that earliest dispense rolls
   *  off and frees a unit — turning a `quantity_exceeded` result from a
   *  dead end into an actionable date. `null`/omitted → `quantityEligibleOn`
   *  is null. */
  earliestDispenseInPeriodAt?: Date | null;
  /** Current moment. Pass `new Date()` in production; tests pass a
   *  fixed instant for determinism. */
  now: Date;
}

export interface ResupplyEntitlementResult {
  status: EntitlementStatus;
  /** Conjunction of the interval and quantity gates. */
  eligible: boolean;
  /** Earliest date the INTERVAL gate is open. Equal to `now` when the
   *  patient has never been dispensed this code (eligible immediately
   *  on the interval axis). */
  eligibleOn: Date;
  /** Whole days until the interval gate opens; 0 when already open.
   *  Does NOT reflect the quantity gate (see file header). */
  daysUntilEligible: number;
  /** How many units could be dispensed right now without exceeding the
   *  period cap (`max(0, maxQuantityPerPeriod - quantityInPeriod)`). */
  maxQuantityNow: number;
  /** Date the QUANTITY gate next frees a unit — the earliest in-period
   *  dispense (`earliestDispenseInPeriodAt`) plus `periodDays`. `null`
   *  when the earliest in-period dispense wasn't supplied, or when the
   *  quantity gate isn't the binding constraint. */
  quantityEligibleOn: Date | null;
  /** Human-readable explanation for the CSR UI / audit row. */
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveResupplyEntitlement(
  input: ResupplyEntitlementInput,
): ResupplyEntitlementResult {
  const { lastFulfilledAt, now } = input;

  // Defensive clamps — a negative count (data artifact) or absent
  // requested quantity must not silently open or close a gate.
  const quantityInPeriod = Math.max(0, input.quantityInPeriod);
  const requestedQuantity = Math.max(1, input.requestedQuantity ?? 1);

  // Clamp the reference-data numerics to finite, non-negative values the
  // same way the sibling refill-window / timely-filing modules do. Bad
  // reference data (a NaN / Infinity / negative `min_interval_days`) must
  // NOT silently authorize a dispense: an un-clamped NaN makes `eligibleOn`
  // an Invalid Date, whose comparisons are all false, so `tooSoon` reads
  // false and the patient is reported eligible — a too-soon dispense and
  // an avoidable denial. Treat non-finite/negative as 0 (no gate) so the
  // result is at least deterministic and explainable rather than an
  // Invalid-Date artifact.
  const minIntervalDays = Number.isFinite(input.minIntervalDays)
    ? Math.max(0, input.minIntervalDays)
    : 0;
  const maxQuantityPerPeriod = Number.isFinite(input.maxQuantityPerPeriod)
    ? Math.max(0, input.maxQuantityPerPeriod)
    : 0;
  const periodDays = Number.isFinite(input.periodDays)
    ? Math.max(0, input.periodDays)
    : 0;
  const graceDays = Number.isFinite(input.graceDays)
    ? Math.max(0, input.graceDays as number)
    : 0;
  // The early-ship grace can never push the effective interval below 0.
  const effectiveIntervalDays = Math.max(0, minIntervalDays - graceDays);

  // ── Interval gate ───────────────────────────────────────────────
  // A `null` last-fill is a first fill → the gate is open. A *corrupt*
  // (Invalid Date) last-fill must NOT silently open it: an un-guarded
  // `NaN` getTime() makes `eligibleOn` an Invalid Date, every comparison
  // reads false, `tooSoon` is false, and the patient is reported eligible
  // — the exact "silently authorize a dispense" failure the reference-data
  // clamps above guard against. Fail safe by anchoring the interval at
  // `now` (treat the unknown last dispense as just-happened), blocking for
  // the full interval rather than waving the dispense through.
  const lastFulfilledMs =
    lastFulfilledAt === null ? null : lastFulfilledAt.getTime();
  const intervalAnchorMs =
    lastFulfilledAt === null
      ? null
      : Number.isFinite(lastFulfilledMs)
        ? (lastFulfilledMs as number)
        : now.getTime();
  const eligibleOn =
    intervalAnchorMs === null
      ? now
      : new Date(intervalAnchorMs + effectiveIntervalDays * DAY_MS);
  const tooSoon = eligibleOn.getTime() > now.getTime();
  const daysUntilEligible = tooSoon
    ? Math.ceil((eligibleOn.getTime() - now.getTime()) / DAY_MS)
    : 0;

  // ── Quantity gate ───────────────────────────────────────────────
  const maxQuantityNow = Math.max(0, maxQuantityPerPeriod - quantityInPeriod);
  const quantityExceeded = requestedQuantity > maxQuantityNow;

  // The quantity gate clears for one unit when the earliest dispense still
  // inside the rolling period rolls off (earliest + periodDays). We can
  // only date this when the caller supplied that earliest timestamp; it's
  // reported only when quantity is actually the binding constraint.
  const earliest = input.earliestDispenseInPeriodAt ?? null;
  const quantityEligibleOn =
    quantityExceeded && !tooSoon && earliest !== null
      ? new Date(earliest.getTime() + periodDays * DAY_MS)
      : null;

  const eligible = !tooSoon && !quantityExceeded;

  // Status precedence: report the interval block first — its date is
  // the actionable fact the CSR/patient needs ("eligible on May 12").
  // Quantity exhaustion is reported only when the interval is already
  // open, since that's the binding constraint in that case.
  let status: EntitlementStatus;
  let reason: string;
  if (tooSoon) {
    status = "too_soon";
    reason =
      `Not yet eligible — ${minIntervalDays} days must elapse between ` +
      `dispenses. Eligible in ${daysUntilEligible} day` +
      `${daysUntilEligible === 1 ? "" : "s"}.`;
  } else if (quantityExceeded) {
    status = "quantity_exceeded";
    reason =
      `Requested ${requestedQuantity} but only ${maxQuantityNow} more ` +
      `allowed in the current ${periodDays}-day period ` +
      `(max ${maxQuantityPerPeriod}).` +
      (quantityEligibleOn !== null
        ? ` One unit frees up on ${quantityEligibleOn.toISOString().slice(0, 10)}.`
        : "");
  } else {
    status = "eligible";
    reason = "Eligible for resupply.";
  }

  return {
    status,
    eligible,
    eligibleOn,
    daysUntilEligible,
    maxQuantityNow,
    quantityEligibleOn,
    reason,
  };
}
