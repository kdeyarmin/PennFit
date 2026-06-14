// Smart-trigger rule evaluation (Phase E.2 / feature #19).
//
// Each rule is a pure function that takes a window of nightly
// therapy data and returns either:
//   * null  — no trigger fired
//   * a TriggerProposal  — patient_id + kind + the window we
//     evaluated, so the upstream caller can insert a row.
//
// Pure functions to keep the test surface tight: the upstream
// evaluator endpoint fetches data, calls each rule, and writes
// the proposals; rules don't touch the DB or the network.
//
// Why rule-based and not ML: a rule like "14-day rolling leak
// rate trended up by 30%" is auditable, explainable, and tunable
// by a clinician. A black-box model would be neither at this stage.

export type TriggerKind =
  | "leak_rising"
  | "usage_dropping"
  | "cushion_wear"
  | "humidifier_drop"
  | "ahi_elevated"
  | "non_adherent_30d"
  // Clinical signals derived from the imported manufacturer data —
  // RT-owned, never auto-messaged to the patient (see
  // PATIENT_DISPATCH_KINDS below):
  //   * pressure_at_max — APAP pegged at the device's max pressure
  //     with residual events → under-titrated, needs a Rx/pressure
  //     review (the device wants to go higher but can't).
  //   * ahi_rising      — AHI worsening *trend* (caught before it
  //     crosses the absolute ahi_elevated alarm).
  //   * usage_erratic   — binge-and-skip usage pattern (decent average
  //     hiding wild night-to-night swings) → consistency coaching.
  | "pressure_at_max"
  | "ahi_rising"
  | "usage_erratic";

/**
 * Subset of TriggerKind that the patient-facing dispatcher
 * (lib/smart-triggers/dispatcher.ts) is allowed to auto-send to
 * patients via email / SMS / push.
 *
 * The first four are nudges that prescribe a clear, self-serve next
 * step ("reply YES to ship a fresh cushion") and have been clinically
 * reviewed as safe to send without RT intervention.
 *
 * `ahi_elevated` and `non_adherent_30d` are CLINICAL signals — they
 * indicate the patient's therapy itself may not be working, which is
 * a conversation the RT should own. Auto-emailing a patient "your AHI
 * is elevated" without clinician context risks alarming them or
 * implying a diagnosis we're not licensed to make. These kinds still
 * land in patient_smart_trigger_events so the RT board surfaces them,
 * but the dispatcher skips them on its way to SendGrid/Twilio.
 */
export const PATIENT_DISPATCH_KINDS: ReadonlyArray<TriggerKind> = [
  "leak_rising",
  "usage_dropping",
  "cushion_wear",
  "humidifier_drop",
];

/** True when the dispatcher is allowed to auto-message the patient. */
export function isPatientDispatchableKind(kind: string): boolean {
  return (PATIENT_DISPATCH_KINDS as readonly string[]).includes(kind);
}

export interface NightDatum {
  /** YYYY-MM-DD. */
  date: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
}

export interface TriggerProposal {
  kind: TriggerKind;
  windowStartDate: string;
  windowEndDate: string;
}

/**
 * Per-patient context the rule library needs beyond the nightly rows —
 * currently just the device's configured max pressure (from the latest
 * vendor snapshot's DeviceSettings.pressureMaxCmh2o). The
 * pressure-pegging rule compares the nightly P95 pressure against this
 * ceiling; the other rules ignore it. Optional everywhere so a patient
 * with no settings snapshot still evaluates every non-pressure rule.
 */
export interface EvaluationContext {
  deviceMaxPressureCmh2o?: number | null;
}

const WINDOW_DAYS = 14;
const MIN_NIGHTS_FOR_RULE = 10;

/**
 * Returns the most recent N nights from `nights`, sorted ascending
 * by date. Caller can pass any order — we sort here so rule logic
 * doesn't have to defend against the input shape.
 */
function trailingWindow(nights: NightDatum[], n: number): NightDatum[] {
  const sorted = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(Math.max(0, sorted.length - n));
}

function avg(xs: ReadonlyArray<number | null>): number | null {
  const present = xs.filter((x): x is number => x !== null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

/**
 * Population standard deviation of the present (non-null) values, or
 * null when fewer than two values are present (a single point has no
 * spread). Population (÷N) not sample (÷N-1): we're describing the
 * nights we observed, not inferring a wider distribution.
 */
function stdev(xs: ReadonlyArray<number | null>): number | null {
  const present = xs.filter((x): x is number => x !== null);
  if (present.length < 2) return null;
  const mean = present.reduce((a, b) => a + b, 0) / present.length;
  const variance =
    present.reduce((a, b) => a + (b - mean) * (b - mean), 0) / present.length;
  return Math.sqrt(variance);
}

/**
 * Rule: leak rate has risen materially over the trailing 14 nights.
 * "Materially" = the back half of the window averages ≥ 30% higher
 * leak than the front half, AND the absolute back-half average is
 * above a noise floor (2 L/min) so we don't fire on jitter near zero.
 */
export function evaluateLeakRising(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, WINDOW_DAYS);
  if (window.length < MIN_NIGHTS_FOR_RULE) return null;
  const half = Math.floor(window.length / 2);
  const front = avg(window.slice(0, half).map((n) => n.leakRateLMin));
  const back = avg(window.slice(half).map((n) => n.leakRateLMin));
  if (front === null || back === null) return null;
  const NOISE_FLOOR = 2;
  const RISE_FACTOR = 1.3;
  if (back < NOISE_FLOOR) return null;
  if (back < front * RISE_FACTOR) return null;
  return {
    kind: "leak_rising",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: nightly usage minutes have fallen materially. Mirrors the
 * leak-rising rule on the opposite direction, with an absolute
 * floor — we only flag a drop into the "below CMS adherence"
 * range (<240 min/night for 70% of nights).
 */
export function evaluateUsageDropping(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, WINDOW_DAYS);
  if (window.length < MIN_NIGHTS_FOR_RULE) return null;
  const half = Math.floor(window.length / 2);
  const front = avg(window.slice(0, half).map((n) => n.usageMinutes));
  const back = avg(window.slice(half).map((n) => n.usageMinutes));
  if (front === null || back === null) return null;
  const DROP_FACTOR = 0.7;
  const ADHERENCE_THRESHOLD_MIN = 240;
  if (back > ADHERENCE_THRESHOLD_MIN) return null;
  if (back > front * DROP_FACTOR) return null;
  return {
    kind: "usage_dropping",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: cushion wear inferred from leak + AHI. When BOTH leak and
 * AHI are trending up across the same window, the most likely
 * cause is a worn cushion (a leak alone could be a fit issue; an
 * AHI rise alone could be many things; both together points at
 * the cushion seal failing).
 */
export function evaluateCushionWear(
  nights: NightDatum[],
): TriggerProposal | null {
  const leak = evaluateLeakRising(nights);
  if (!leak) return null;
  const window = trailingWindow(nights, WINDOW_DAYS);
  const half = Math.floor(window.length / 2);
  const frontAhi = avg(window.slice(0, half).map((n) => n.ahi));
  const backAhi = avg(window.slice(half).map((n) => n.ahi));
  if (frontAhi === null || backAhi === null) return null;
  const AHI_RISE_FACTOR = 1.2;
  if (backAhi < frontAhi * AHI_RISE_FACTOR) return null;
  return {
    kind: "cushion_wear",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: humidifier-usage drop in stable-pressure conditions.
 * Stand-in detection until we have explicit humidifier-on minutes
 * from the partner: when pressure is stable but usage minutes drop,
 * AND it's a summer month (May-Sep), a tubing change often helps.
 *
 * The seasonal gate is intentionally loose — clinically-meaningful
 * detection arrives once partner data exposes humidifier minutes;
 * this rule seeds the table so the dispatcher path works end to end.
 */
export function evaluateHumidifierDrop(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, WINDOW_DAYS);
  if (window.length < MIN_NIGHTS_FOR_RULE) return null;
  const half = Math.floor(window.length / 2);
  const frontPress = avg(window.slice(0, half).map((n) => n.pressureP95Cmh2o));
  const backPress = avg(window.slice(half).map((n) => n.pressureP95Cmh2o));
  if (frontPress === null || backPress === null) return null;
  // Pressure stability: within ±10%.
  if (Math.abs(backPress - frontPress) / frontPress > 0.1) return null;
  const usageDrop = evaluateUsageDropping(nights);
  if (!usageDrop) return null;
  const lastDate = window[window.length - 1]!.date;
  const monthIdx = Number(lastDate.slice(5, 7));
  if (monthIdx < 5 || monthIdx > 9) return null;
  return {
    kind: "humidifier_drop",
    windowStartDate: window[0]!.date,
    windowEndDate: lastDate,
  };
}

/**
 * Rule: AHI is clinically elevated in the very recent window.
 *
 * AHI < 5 is the line CMS treats as "well controlled apnea" and is
 * the threshold every CPAP titration aims to keep the patient under.
 * When a previously-controlled patient logs ≥3 of the last 7 nights
 * with AHI > 5, that's a strong signal for the RT to investigate —
 * mask fit, pressure setting, weight change, sleep position. The
 * existing leak_rising / cushion_wear rules trend across 14 nights;
 * this rule is the short-window companion that catches "AHI jumped
 * this week, the patient hasn't called yet."
 *
 * Requires ≥5 nights of data (so a single noisy reading doesn't
 * fire it) and at least 3 nights breaching the threshold.
 */
const AHI_THRESHOLD = 5;
const AHI_BREACH_COUNT = 3;
const AHI_WINDOW_NIGHTS = 7;

export function evaluateAhiElevated(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, AHI_WINDOW_NIGHTS);
  if (window.length < 5) return null;
  let breaches = 0;
  for (const n of window) {
    if (n.ahi !== null && n.ahi > AHI_THRESHOLD) breaches += 1;
  }
  if (breaches < AHI_BREACH_COUNT) return null;
  return {
    kind: "ahi_elevated",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: CMS Medicare adherence is failing across the 30-day window.
 *
 * CMS requires "≥4 hours on ≥70% of nights in any 30-consecutive-
 * night window in the first 90 days" for continued PAP coverage.
 * The compliance scanner (lib/compliance-scanner.ts) tracks the
 * formal `csr_compliance_alerts` row used for the PA renewal
 * paperwork; this rule fires a SOFT signal for the RT board so the
 * patient appears in the daily review BEFORE the compliance scan
 * flips them to "non-adherent" status.
 *
 * Requires ≥21 nights of data (avoids firing on a brand-new patient
 * before their 30-night window has filled).
 */
const ADHERENCE_USAGE_MIN = 240; // 4 hours
const ADHERENCE_TARGET_RATE = 0.7;
const ADHERENCE_WINDOW_NIGHTS = 30;
const ADHERENCE_MIN_DATA = 21;

export function evaluateNonAdherent30d(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, ADHERENCE_WINDOW_NIGHTS);
  if (window.length < ADHERENCE_MIN_DATA) return null;
  let adherent = 0;
  let counted = 0;
  for (const n of window) {
    if (n.usageMinutes === null) continue;
    counted += 1;
    if (n.usageMinutes >= ADHERENCE_USAGE_MIN) adherent += 1;
  }
  if (counted < ADHERENCE_MIN_DATA) return null;
  if (adherent / counted >= ADHERENCE_TARGET_RATE) return null;
  return {
    kind: "non_adherent_30d",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: APAP pressure is pegged at the device's configured ceiling
 * while residual events persist — i.e. the device is under-titrated.
 *
 * An auto-titrating machine raises pressure to abort events. When the
 * nightly 95th-percentile pressure sits at (within PEG_MARGIN of) the
 * prescribed MAX on most recent nights AND the patient's AHI is still
 * elevated, the device "wants" to go higher but can't — the cap is too
 * low for this patient. That's a prescription/pressure-review
 * conversation for the RT, and one the threshold scans miss entirely
 * (they look at AHI and leak in isolation, never pressure-vs-ceiling).
 *
 * Needs the device max from the latest vendor snapshot; returns null
 * when it's unknown (can't judge "at max" without the ceiling) or when
 * there isn't enough recent data. Requiring residual AHI keeps the
 * signal actionable — a well-controlled patient who simply runs near
 * max is fine and must not be flagged.
 */
const PRESSURE_WINDOW_NIGHTS = 7;
const PRESSURE_MIN_NIGHTS = 5;
const PRESSURE_PEG_MARGIN_CMH2O = 1.0;
const PRESSURE_PEG_BREACH = 4;
const PRESSURE_RESIDUAL_AHI = 5;

export function evaluatePressureAtMax(
  nights: NightDatum[],
  ctx?: EvaluationContext,
): TriggerProposal | null {
  const deviceMax = ctx?.deviceMaxPressureCmh2o;
  if (deviceMax == null || !(deviceMax > 0)) return null;
  const window = trailingWindow(nights, PRESSURE_WINDOW_NIGHTS);
  const withPressure = window.filter((n) => n.pressureP95Cmh2o !== null);
  if (withPressure.length < PRESSURE_MIN_NIGHTS) return null;
  const pegged = withPressure.filter(
    (n) => n.pressureP95Cmh2o! >= deviceMax - PRESSURE_PEG_MARGIN_CMH2O,
  ).length;
  if (pegged < PRESSURE_PEG_BREACH) return null;
  // Only actionable when events are still breaking through at the cap.
  const meanAhi = avg(window.map((n) => n.ahi));
  if (meanAhi === null || meanAhi < PRESSURE_RESIDUAL_AHI) return null;
  return {
    kind: "pressure_at_max",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: AHI is on a worsening *trend* — caught before it crosses the
 * absolute ahi_elevated alarm (≥5 on ≥3 of 7 nights).
 *
 * `evaluateAhiElevated` is a level alarm; this is its early-warning
 * companion. Over the trailing 14 nights, if the back half averages
 * materially higher AHI than the front half AND the back half is above
 * a meaningful floor (so we don't fire on jitter near zero), the
 * patient is deteriorating — emerging central apnea, weight change,
 * mask/pressure drift — and the RT can intervene a week before the
 * level alarm would. Capped below the absolute threshold so a patient
 * already firing ahi_elevated isn't double-flagged for the same week.
 */
const AHI_RISE_FACTOR = 1.5;
const AHI_RISE_FLOOR = 3;

export function evaluateAhiRising(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, WINDOW_DAYS);
  if (window.length < MIN_NIGHTS_FOR_RULE) return null;
  const half = Math.floor(window.length / 2);
  const front = avg(window.slice(0, half).map((n) => n.ahi));
  const back = avg(window.slice(half).map((n) => n.ahi));
  if (front === null || back === null) return null;
  if (back < AHI_RISE_FLOOR) return null;
  // Once the back half is itself at/over the absolute alarm line, the
  // level rule (ahi_elevated) owns it — don't double-fire.
  if (back >= AHI_THRESHOLD) return null;
  if (back < front * AHI_RISE_FACTOR) return null;
  return {
    kind: "ahi_rising",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/**
 * Rule: binge-and-skip usage pattern — a decent *average* hiding wild
 * night-to-night swings.
 *
 * A patient who uses CPAP 8 hours some nights and skips others can post
 * an average that looks acceptable while sitting one bad week away from
 * blowing the Medicare 70%-of-nights bar — and the inconsistency itself
 * predicts long-term abandonment. The trend rules (usage_dropping)
 * only catch a sustained decline; this catches volatility. We require a
 * high coefficient of variation AND an explicit mix of near-zero and
 * full-therapy nights so we fire on true erraticism, not a steady
 * borderline user.
 */
const USAGE_ERRATIC_MIN_NIGHTS = 10;
const USAGE_ERRATIC_CV = 0.5;
const USAGE_ERRATIC_SKIP_MIN = 60; // a "skipped/barely-used" night
const USAGE_ERRATIC_FULL_MIN = 240; // a "full therapy" night (4h+)
const USAGE_ERRATIC_MIX_COUNT = 3;

export function evaluateUsageErratic(
  nights: NightDatum[],
): TriggerProposal | null {
  const window = trailingWindow(nights, WINDOW_DAYS);
  const usage = window
    .map((n) => n.usageMinutes)
    .filter((v): v is number => v !== null);
  if (usage.length < USAGE_ERRATIC_MIN_NIGHTS) return null;
  const mean = avg(usage);
  const sd = stdev(usage);
  if (mean === null || sd === null || mean <= 0) return null;
  if (sd / mean < USAGE_ERRATIC_CV) return null;
  const skipNights = usage.filter((v) => v < USAGE_ERRATIC_SKIP_MIN).length;
  const fullNights = usage.filter((v) => v >= USAGE_ERRATIC_FULL_MIN).length;
  if (skipNights < USAGE_ERRATIC_MIX_COUNT) return null;
  if (fullNights < USAGE_ERRATIC_MIX_COUNT) return null;
  return {
    kind: "usage_erratic",
    windowStartDate: window[0]!.date,
    windowEndDate: window[window.length - 1]!.date,
  };
}

/** Run every rule and return the proposals that fire. */
export function evaluateAll(
  nights: NightDatum[],
  ctx?: EvaluationContext,
): TriggerProposal[] {
  const out: TriggerProposal[] = [];
  // Rules that read only the nightly rows.
  for (const fn of [
    evaluateLeakRising,
    evaluateUsageDropping,
    evaluateCushionWear,
    evaluateHumidifierDrop,
    evaluateAhiElevated,
    evaluateNonAdherent30d,
    evaluateAhiRising,
    evaluateUsageErratic,
  ]) {
    const r = fn(nights);
    if (r) out.push(r);
  }
  // Context-aware rules (need the device settings snapshot).
  const pressure = evaluatePressureAtMax(nights, ctx);
  if (pressure) out.push(pressure);
  return out;
}
