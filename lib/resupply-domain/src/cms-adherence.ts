// Medicare 90-day CPAP adherence rule — pure window finder (ADR 008: no
// I/O, no Date.now()).
//
// What Medicare requires
// ----------------------
// CMS LCD L33718 (CPAP/RAD) requires the supplier to document, by month 4
// of therapy, that the beneficiary used the device:
//
//   * ≥ 4 hours per night (COMPLIANT_MINUTES_PER_NIGHT)
//   * on ≥ 70% of nights (COMPLIANCE_NIGHT_RATIO → ≥ 21 of 30 calendar
//     days, CMS_COMPLIANT_NIGHTS)
//   * in any consecutive 30-day period (WINDOW_DAYS) within the first
//     90 days (ATTESTATION_HORIZON_DAYS).
//
// A patient who hits that threshold qualifies for ongoing rental coverage;
// one who doesn't gets the device pulled in month 4.
//
// Why this lives in @workspace/resupply-domain
// --------------------------------------------
// This is THE CMS coverage rule, and a drift between independent copies of
// the 240-minute / 21-night / 30-day / 90-day constants produces a wrong
// compliance label — which drives a wrong claim. It used to live in the
// I/O app (`artifacts/.../lib/compliance-attestation.ts`) while three other
// callsites (the adherence predictor, the adherence feature extractor, the
// compliance scanner) re-hardcoded the same magic numbers. Hoisting the
// constants + the window search here gives every callsite one tested
// source of truth, and lets the SPA reason about "does this patient
// qualify?" without importing the API artifact.
//
// The route/PDF layer (`compliance-attestation.ts`) still owns pulling
// therapy_nights from the DB, source-dedupe, audit, and rendering — this
// module is purely the math.

/** Adherence threshold: ≥ 4 hours of use per night. */
export const COMPLIANT_MINUTES_PER_NIGHT = 240;
/** Required share of compliant nights inside the 30-day window. */
export const COMPLIANCE_NIGHT_RATIO = 0.7;
/** Number of consecutive days in the qualifying window. */
export const WINDOW_DAYS = 30;
/** First-90-days probe horizon. */
export const ATTESTATION_HORIZON_DAYS = 90;
/** Minimum compliant nights inside the window, derived from the ratio so
 *  the "21 of 30" figure can never drift away from the ratio it encodes
 *  (Math.ceil(30 × 0.7) = 21). Callers that count nights directly (the
 *  predictor / feature extractor) import this instead of re-hardcoding. */
export const CMS_COMPLIANT_NIGHTS = Math.ceil(
  WINDOW_DAYS * COMPLIANCE_NIGHT_RATIO,
);

export interface AdherenceNight {
  /** YYYY-MM-DD. The single source-priority-deduped night value. */
  date: string;
  /** Null when the night reported metadata but no usage minutes
   *  (e.g. seal/leak only). Treated as 0 for adherence math. */
  usageMinutes: number | null;
}

export interface AdherenceWindow {
  /** Inclusive start date (YYYY-MM-DD). */
  startDate: string;
  /** Inclusive end date (YYYY-MM-DD), exactly 29 days after start. */
  endDate: string;
  /** Number of calendar days in the window that hit
   *  COMPLIANT_MINUTES_PER_NIGHT. Always relative to 30 days, NOT
   *  to "days that reported data" — Medicare's denominator is
   *  calendar days. */
  compliantNights: number;
  /** compliantNights / WINDOW_DAYS, rounded to 4 decimals. */
  ratio: number;
  /** True iff ratio >= COMPLIANCE_NIGHT_RATIO. */
  qualifies: boolean;
  /** Mean nightly hours across nights WITH usage data (so a
   *  patient who slept-with-CPAP 25 of 30 nights and reported 7
   *  hours each gets 7.0 hours, not 7.0 * 25/30). For display. */
  averageUsageHoursOnUsedNights: number | null;
}

export interface AdherenceResult {
  /** True iff at least one window in the 90-day probe qualifies. */
  qualifies: boolean;
  /** The window we elect to attest to. When qualifies=true this is
   *  the FIRST window (chronologically) that hit the threshold —
   *  matching how an auditor reads "the patient qualified on date X".
   *  When qualifies=false this is the BEST window (highest ratio)
   *  inside the probe, useful for the "patient is at 65% — keep
   *  coaching" admin view. Null when the patient has no usage data
   *  inside the 90-day horizon at all. */
  window: AdherenceWindow | null;
  /** True iff the 90-day probe horizon is fully behind us — set by
   *  comparing today against (anchorDate + 90). We compute it here so
   *  the renderer can mark the attestation "final" vs "interim". */
  horizonComplete: boolean;
}

/**
 * Find the best 30-day adherence window in the first 90 days
 * starting at `anchorDate`. Nights outside the horizon are ignored.
 *
 * @param nights nightly usage rows, ANY order — we sort + index by
 *   date internally. Same date appearing twice is undefined behavior;
 *   callers must dedupe before passing in.
 * @param anchorDate YYYY-MM-DD — day 1 of the 90-day probe (typically
 *   the patient's earliest therapy_night date).
 * @param asOfDate today's YYYY-MM-DD. Used only to compute
 *   `horizonComplete`; not used in the window search itself.
 */
export function findBestAdherenceWindow(
  nights: AdherenceNight[],
  anchorDate: string,
  asOfDate: string,
): AdherenceResult {
  const anchor = parseIsoDate(anchorDate);
  const asOf = parseIsoDate(asOfDate);
  if (!anchor || !asOf) {
    return { qualifies: false, window: null, horizonComplete: false };
  }

  const horizonEnd = addDays(anchor, ATTESTATION_HORIZON_DAYS - 1);
  const horizonComplete = asOf.getTime() >= horizonEnd.getTime();

  // Build a date -> usageMinutes map for O(1) per-day lookup inside
  // the sliding window.
  const usageByDate = new Map<string, number>();
  for (const n of nights) {
    if (!n.date) continue;
    const minutes = n.usageMinutes ?? 0;
    usageByDate.set(n.date, minutes);
  }

  if (usageByDate.size === 0) {
    return { qualifies: false, window: null, horizonComplete };
  }

  // The last window we can probe must end on or before the horizon
  // end AND on or before today (you can't attest based on dates
  // that haven't happened yet).
  const latestWindowStart = minDate(
    addDays(horizonEnd, -(WINDOW_DAYS - 1)),
    addDays(asOf, -(WINDOW_DAYS - 1)),
  );

  if (latestWindowStart.getTime() < anchor.getTime()) {
    // Not enough elapsed time for a full 30-day window yet.
    return { qualifies: false, window: null, horizonComplete };
  }

  let firstQualifying: AdherenceWindow | null = null;
  let bestNonQualifying: AdherenceWindow | null = null;

  for (
    let start = new Date(anchor);
    start.getTime() <= latestWindowStart.getTime();
    start = addDays(start, 1)
  ) {
    const window = scoreWindow(start, usageByDate);
    if (window.qualifies && !firstQualifying) {
      firstQualifying = window;
      break; // Earliest qualifying window is the canonical answer.
    }
    if (!bestNonQualifying || window.ratio > bestNonQualifying.ratio) {
      bestNonQualifying = window;
    }
  }

  if (firstQualifying) {
    return { qualifies: true, window: firstQualifying, horizonComplete };
  }
  return {
    qualifies: false,
    window: bestNonQualifying,
    horizonComplete,
  };
}

function scoreWindow(
  start: Date,
  usageByDate: Map<string, number>,
): AdherenceWindow {
  let compliantNights = 0;
  let usedNightMinutes = 0;
  let usedNightCount = 0;

  for (let i = 0; i < WINDOW_DAYS; i++) {
    const day = addDays(start, i);
    const key = isoDate(day);
    const minutes = usageByDate.get(key);
    if (minutes != null) {
      if (minutes > 0) {
        usedNightMinutes += minutes;
        usedNightCount += 1;
      }
      if (minutes >= COMPLIANT_MINUTES_PER_NIGHT) {
        compliantNights += 1;
      }
    }
    // Missing dates: counted as zero usage for adherence ratio —
    // matches CMS's "calendar days" denominator. Not added to
    // usedNightMinutes (which only averages nights with reported
    // usage so the display stays honest).
  }

  const ratio = compliantNights / WINDOW_DAYS;
  const qualifies = ratio >= COMPLIANCE_NIGHT_RATIO;
  const endDate = addDays(start, WINDOW_DAYS - 1);

  return {
    startDate: isoDate(start),
    endDate: isoDate(endDate),
    compliantNights,
    ratio: Math.round(ratio * 10_000) / 10_000,
    qualifies,
    averageUsageHoursOnUsedNights:
      usedNightCount === 0
        ? null
        : Math.round((usedNightMinutes / usedNightCount / 60) * 100) / 100,
  };
}

function parseIsoDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Use UTC so date math is timezone-free; we only care about
  // calendar-day boundaries here.
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
