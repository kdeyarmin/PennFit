// RT (Respiratory Therapist) overview aggregations.
//
// Pure transforms over data already collected by the existing
// integration adapters (resupply-integrations-airview, resupply-
// integrations-care-orchestrator, react-health, health-connect) and
// the smart-trigger evaluator. The /admin/rt-overview route reads
// the underlying tables and hands the rows here to roll up; no
// schema additions, no new write paths.
//
// Two surfaces:
//
//   1. aggregatePatientWindow — per-patient roll-up of recent therapy
//      nights. Inputs: that patient's night rows + the as-of time +
//      the window length. Outputs: avg AHI / leak / usage-min, last
//      night date, staleDays. Returns null fields when there is no
//      data in the window so the UI can render "—" instead of "0".
//
//   2. summarizeOverview — fleet-level rollup over an array of
//      per-patient rows. Used for the "X active, Y alerting, Z stale"
//      header cards.
//
// Decisions worth knowing:
//   * usage_minutes is integer; averages are still computed as floats
//     and rounded for display by the caller.
//   * ahi + leak_rate_l_min come off PostgREST as `string | null`
//     because they're numeric(5,2) in the DB. We parse via Number()
//     and drop NaN / null values from the average. A night with a
//     `null` metric still counts toward `nightsInWindow` (the patient
//     slept) but does NOT pull the average for that metric down.
//   * staleDays = ceil((asOf − lastNightDate) / day). A patient with
//     a night TODAY has staleDays=0; no night ever → null.

export interface TherapyNightInput {
  /** ISO date 'YYYY-MM-DD'. */
  night_date: string;
  usage_minutes: number | null;
  /** Numeric strings from PostgREST. */
  ahi: string | null;
  leak_rate_l_min: string | null;
}

export interface PatientWindowSummary {
  nightsInWindow: number;
  lastNightDate: string | null;
  /** Whole-day staleness. Null when the patient has never logged a night. */
  staleDays: number | null;
  /** Rounded to 1 decimal; null when no usable nights in the window. */
  ahiAvg: number | null;
  /** Rounded to 1 decimal; null when no usable nights in the window. */
  leakAvg: number | null;
  /** Rounded to integer minutes; null when no usable nights in the window. */
  usageMinutesAvg: number | null;
}

const MS_PER_DAY = 86_400_000;

function dateOnly(iso: string): string {
  // Both YYYY-MM-DD and full ISO timestamps work for therapy_nights —
  // the DB column is `date`, but a few legacy paths stuffed a timestamp
  // in. Slice defensively.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(`${dateOnly(aIso)}T00:00:00Z`);
  const b = Date.parse(`${dateOnly(bIso)}T00:00:00Z`);
  return Math.ceil((a - b) / MS_PER_DAY);
}

function parseMetric(raw: string | null): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Roll up one patient's recent nights for the RT dashboard.
 *
 * Nights outside `[asOfDate - windowDays + 1 ... asOfDate]` are
 * dropped before aggregation. Order of input is irrelevant — the
 * function sorts internally to pick `lastNightDate` and compute
 * `staleDays`.
 */
export function aggregatePatientWindow(
  nights: TherapyNightInput[],
  asOfIso: string,
  windowDays: number,
): PatientWindowSummary {
  const asOf = dateOnly(asOfIso);
  // Inclusive window: today and the previous (windowDays-1) days.
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const lowerBound = asOfMs - (windowDays - 1) * MS_PER_DAY;

  // Pick out the latest night across ALL nights (used for staleDays
  // even when nothing is in the window). And separately collect the
  // nights inside the window for averaging.
  let latestNightDate: string | null = null;
  const inWindow: TherapyNightInput[] = [];
  for (const n of nights) {
    const nd = dateOnly(n.night_date);
    const ndMs = Date.parse(`${nd}T00:00:00Z`);
    if (Number.isNaN(ndMs)) continue;
    if (latestNightDate === null || nd > latestNightDate) {
      latestNightDate = nd;
    }
    if (ndMs >= lowerBound && ndMs <= asOfMs) {
      inWindow.push(n);
    }
  }

  const ahis: number[] = [];
  const leaks: number[] = [];
  const usages: number[] = [];
  for (const n of inWindow) {
    const a = parseMetric(n.ahi);
    if (a !== null) ahis.push(a);
    const l = parseMetric(n.leak_rate_l_min);
    if (l !== null) leaks.push(l);
    if (typeof n.usage_minutes === "number") usages.push(n.usage_minutes);
  }

  const ahiAvg = avg(ahis);
  const leakAvg = avg(leaks);
  const usageMinutesAvg = avg(usages);

  return {
    nightsInWindow: inWindow.length,
    lastNightDate: latestNightDate,
    staleDays:
      latestNightDate === null
        ? null
        : Math.max(0, daysBetween(asOf, latestNightDate)),
    ahiAvg: ahiAvg === null ? null : Math.round(ahiAvg * 10) / 10,
    leakAvg: leakAvg === null ? null : Math.round(leakAvg * 10) / 10,
    usageMinutesAvg:
      usageMinutesAvg === null ? null : Math.round(usageMinutesAvg),
  };
}

export interface OverviewRowLike {
  nightsInWindow: number;
  staleDays: number | null;
  activeAlerts: string[];
  hasTherapyLink: boolean;
}

export interface OverviewSummary {
  /** Patients with ≥1 night inside the window. */
  totalActive: number;
  /** Patients with at least one undismissed smart-trigger event. */
  totalAlerting: number;
  /**
   * Patients with a live therapy link but no night inside the window.
   * Strong signal that the integration sync is broken for them, or
   * the patient stopped using the device.
   */
  totalStale: number;
}

export function summarizeOverview(rows: OverviewRowLike[]): OverviewSummary {
  let totalActive = 0;
  let totalAlerting = 0;
  let totalStale = 0;
  for (const r of rows) {
    if (r.nightsInWindow > 0) totalActive += 1;
    if (r.activeAlerts.length > 0) totalAlerting += 1;
    if (r.hasTherapyLink && r.nightsInWindow === 0) totalStale += 1;
  }
  return { totalActive, totalAlerting, totalStale };
}

/**
 * Human-friendly labels for the four smart-trigger kinds the
 * evaluator emits. Anything outside this list falls back to the
 * raw kind so a future addition still renders something useful.
 */
export const SMART_TRIGGER_LABELS: Record<string, string> = {
  leak_rising: "Leak rising",
  usage_dropping: "Usage dropping",
  cushion_wear: "Cushion wear",
  humidifier_drop: "Humidifier drop",
  ahi_elevated: "AHI elevated",
  non_adherent_30d: "Non-adherent 30d",
};

export function labelForTriggerKind(kind: string): string {
  return SMART_TRIGGER_LABELS[kind] ?? kind;
}
