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
  | "non_adherent_30d";

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

/** Run every rule and return the proposals that fire. */
export function evaluateAll(nights: NightDatum[]): TriggerProposal[] {
  const out: TriggerProposal[] = [];
  for (const fn of [
    evaluateLeakRising,
    evaluateUsageDropping,
    evaluateCushionWear,
    evaluateHumidifierDrop,
    evaluateAhiElevated,
    evaluateNonAdherent30d,
  ]) {
    const r = fn(nights);
    if (r) out.push(r);
  }
  return out;
}
