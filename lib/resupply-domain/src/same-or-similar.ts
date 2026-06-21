// Medicare "same or similar" equipment-replacement window — pure decision
// (ADR 008: no I/O, no Date.now() except a passed-in clock).
//
// What it models
// --------------
// Medicare pays for replacement DME only after the item's Reasonable
// Useful Lifetime (RUL) has elapsed — 5 years (60 months) for most
// capital equipment (e.g. a PAP device, E0601). If ANY supplier billed
// Medicare for the same-or-similar HCPCS within that window, a new claim
// for the same item is denied ("same or similar equipment on file"). The
// supplier checks this via a HETS 270/271 with EB qualifier F before
// dispensing.
//
// Why this lives in @workspace/resupply-domain
// --------------------------------------------
// The window arithmetic is a pure rule shared by the claim builder, the
// claim preflight, and (once the HETS adapter lands) the network trigger.
// Today the route (routes/admin/same-or-similar.ts) only PERSISTS a CSR's
// hand-checked status — there is no window math anywhere — so modelling it
// here now is purely additive and de-risks the future HETS integration:
// given a prior dispense date it tells you whether the item is still
// inside the RUL and the exact date the window clears.

export const SAME_OR_SIMILAR_STATUSES = ["clear", "active", "unknown"] as const;
export type SameOrSimilarStatus = (typeof SAME_OR_SIMILAR_STATUSES)[number];

/** Reasonable Useful Lifetime for most capital DME — 5 years. */
export const SAME_OR_SIMILAR_WINDOW_MONTHS = 60;

export interface SameOrSimilarInput {
  /** Date the same-or-similar HCPCS was last dispensed / billed to
   *  Medicare (by ANY supplier), as YYYY-MM-DD or a Date. `null` means
   *  no prior on file → clear. */
  lastDispenseOn: string | Date | null;
  /** "Now" for the window check, YYYY-MM-DD or Date. Defaults to the
   *  current instant. */
  asOf?: string | Date;
  /** RUL window in months. Defaults to SAME_OR_SIMILAR_WINDOW_MONTHS (60).
   *  Clamped to a positive integer. */
  windowMonths?: number;
}

export interface SameOrSimilarResult {
  status: SameOrSimilarStatus;
  /** True only when status === "active" — a same-or-similar item is still
   *  inside its RUL, so a new claim is likely to be denied. */
  blocked: boolean;
  /** The date the RUL window clears (lastDispenseOn + windowMonths), as
   *  YYYY-MM-DD. `null` when there is no prior dispense or the input is
   *  unparseable. */
  clearsOn: string | null;
  /** Whole days until `clearsOn`; 0 once cleared, null when not
   *  applicable. */
  daysUntilClear: number | null;
  /** Human-readable explanation for the CSR UI / preflight reason. */
  reason: string;
}

const DAY_MS = 86_400_000;

function toUtcDate(value: string | Date): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addMonthsUtc(d: Date, months: number): Date {
  const next = new Date(d.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Evaluate the same-or-similar window. Pure + total — never throws; an
 * unparseable date returns `unknown` (never a fabricated clear/active),
 * the same honesty posture as the rest of the domain layer.
 */
export function evaluateSameOrSimilar(
  input: SameOrSimilarInput,
): SameOrSimilarResult {
  const windowMonths =
    Number.isFinite(input.windowMonths) && (input.windowMonths as number) > 0
      ? Math.floor(input.windowMonths as number)
      : SAME_OR_SIMILAR_WINDOW_MONTHS;

  // No prior dispense on file → nothing blocks the claim.
  if (input.lastDispenseOn === null) {
    return {
      status: "clear",
      blocked: false,
      clearsOn: null,
      daysUntilClear: null,
      reason: "No same-or-similar equipment on file.",
    };
  }

  const last = toUtcDate(input.lastDispenseOn);
  const asOf = input.asOf != null ? toUtcDate(input.asOf) : new Date();
  if (last === null || asOf === null) {
    return {
      status: "unknown",
      blocked: false,
      clearsOn: null,
      daysUntilClear: null,
      reason: "Same-or-similar status could not be determined.",
    };
  }

  const clears = addMonthsUtc(last, windowMonths);
  const clearsOn = isoDate(clears);
  const stillInWindow = asOf.getTime() < clears.getTime();

  if (stillInWindow) {
    const daysUntilClear = Math.ceil(
      (clears.getTime() - asOf.getTime()) / DAY_MS,
    );
    return {
      status: "active",
      blocked: true,
      clearsOn,
      daysUntilClear,
      reason:
        `Same-or-similar equipment dispensed ${isoDate(last)} is still ` +
        `within its ${windowMonths}-month reasonable useful lifetime; ` +
        `clears ${clearsOn} (${daysUntilClear} day` +
        `${daysUntilClear === 1 ? "" : "s"}).`,
    };
  }

  return {
    status: "clear",
    blocked: false,
    clearsOn,
    daysUntilClear: 0,
    reason: `Prior same-or-similar equipment cleared its lifetime on ${clearsOn}.`,
  };
}
