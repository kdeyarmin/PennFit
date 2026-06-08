// Adherence-model FEATURE EXTRACTION + LABELING (RT #R7, ML harness).
//
// Pure, I/O-free. Turns a patient's therapy nights into (a) a numeric
// feature vector drawn from the first ~2 weeks of therapy and (b) the
// 90-day CMS-compliance label used as the training target. The offline
// trainer (logistic-regression.ts) consumes these; nothing here changes
// the live heuristic predictor.
//
// Feature design mirrors the published early-adherence signals the
// heuristic already leans on (week-1 usage, leak, coverage) plus a
// week-1→week-2 trend, so a trained model can later supersede the
// heuristic on the same inputs.

const COMPLIANT_MINUTES = 240;
const CMS_COMPLIANT_NIGHTS = 21;
const CMS_WINDOW_DAYS = 30;
const HIGH_LEAK_LMIN = 24;

export interface TherapyNightInput {
  /** YYYY-MM-DD. */
  nightDate: string;
  usageMinutes: number | null;
  leakLMin: number | null;
}

export interface AdherenceFeatures {
  week1AvgUsageHours: number;
  week1CompliantRate: number; // 0..1 over week-1 nights with usage
  week1HighLeakRate: number; // 0..1 over week-1 nights with a leak value
  week1Coverage: number; // nights-with-data / 7
  week2AvgUsageHours: number;
  usageTrendHours: number; // week2 avg − week1 avg
}

/** Stable feature order for the model vector. */
export const FEATURE_NAMES: readonly (keyof AdherenceFeatures)[] = [
  "week1AvgUsageHours",
  "week1CompliantRate",
  "week1HighLeakRate",
  "week1Coverage",
  "week2AvgUsageHours",
  "usageTrendHours",
];

function dayIndex(firstIso: string, nightIso: string): number {
  const a = Date.parse(`${firstIso}T00:00:00.000Z`);
  const b = Date.parse(`${nightIso}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.floor((b - a) / 86_400_000);
}

function dedupeSorted(
  nights: readonly TherapyNightInput[],
): TherapyNightInput[] {
  const seen = new Set<string>();
  const out: TherapyNightInput[] = [];
  for (const n of nights) {
    if (!n?.nightDate || seen.has(n.nightDate)) continue;
    seen.add(n.nightDate);
    out.push(n);
  }
  out.sort((a, b) => (a.nightDate < b.nightDate ? -1 : 1));
  return out;
}

function avg(vals: number[]): number {
  return vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;
}

/** Extract the early-therapy feature vector. Pure. */
export function extractAdherenceFeatures(
  nights: readonly TherapyNightInput[],
): AdherenceFeatures {
  const sorted = dedupeSorted(nights);
  if (sorted.length === 0) {
    return {
      week1AvgUsageHours: 0,
      week1CompliantRate: 0,
      week1HighLeakRate: 0,
      week1Coverage: 0,
      week2AvgUsageHours: 0,
      usageTrendHours: 0,
    };
  }
  const first = sorted[0]!.nightDate;
  const week1 = sorted.filter((n) => {
    const d = dayIndex(first, n.nightDate);
    return d >= 0 && d < 7;
  });
  const week2 = sorted.filter((n) => {
    const d = dayIndex(first, n.nightDate);
    return d >= 7 && d < 14;
  });

  const w1Usage = week1
    .map((n) => n.usageMinutes)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const w2Usage = week2
    .map((n) => n.usageMinutes)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const w1Leak = week1
    .map((n) => n.leakLMin)
    .filter((v): v is number => v != null && Number.isFinite(v));

  const week1AvgUsageHours = avg(w1Usage) / 60;
  const week2AvgUsageHours = avg(w2Usage) / 60;
  return {
    week1AvgUsageHours,
    week1CompliantRate:
      w1Usage.length === 0
        ? 0
        : w1Usage.filter((u) => u >= COMPLIANT_MINUTES).length / w1Usage.length,
    week1HighLeakRate:
      w1Leak.length === 0
        ? 0
        : w1Leak.filter((l) => l > HIGH_LEAK_LMIN).length / w1Leak.length,
    week1Coverage: week1.length / 7,
    week2AvgUsageHours,
    usageTrendHours: week2AvgUsageHours - week1AvgUsageHours,
  };
}

/** The model's input vector, in FEATURE_NAMES order. Pure. */
export function toFeatureVector(f: AdherenceFeatures): number[] {
  return FEATURE_NAMES.map((k) => f[k]);
}

/**
 * 90-day CMS-compliance LABEL: 1 if, within the first `windowDays` days
 * of therapy, ANY rolling 30-day window contains ≥21 nights of ≥4h use.
 * This is the training target. Pure.
 */
export function labelCompliant(
  nights: readonly TherapyNightInput[],
  windowDays = 90,
): 0 | 1 {
  const sorted = dedupeSorted(nights);
  if (sorted.length === 0) return 0;
  const first = sorted[0]!.nightDate;
  // Compliant nights (≥4h) within the observation window, as day indices.
  const compliantDays = sorted
    .filter(
      (n) => n.usageMinutes != null && n.usageMinutes >= COMPLIANT_MINUTES,
    )
    .map((n) => dayIndex(first, n.nightDate))
    .filter((d) => d >= 0 && d < windowDays)
    .sort((a, b) => a - b);
  // Slide a 30-day window: for each compliant day, count compliant days
  // within [d, d+29].
  for (let i = 0; i < compliantDays.length; i++) {
    const start = compliantDays[i]!;
    let count = 0;
    for (let j = i; j < compliantDays.length; j++) {
      if (compliantDays[j]! < start + CMS_WINDOW_DAYS) count++;
      else break;
    }
    if (count >= CMS_COMPLIANT_NIGHTS) return 1;
  }
  return 0;
}

export interface TrainingSample {
  x: number[];
  y: 0 | 1;
}

/**
 * Build labeled samples from per-patient night arrays. Each patient with
 * at least `minNights` nights becomes one sample (features from the first
 * 2 weeks, label from the 90-day window). Pure.
 */
export function buildTrainingSamples(
  nightsByPatient: ReadonlyArray<readonly TherapyNightInput[]>,
  minNights = 7,
): TrainingSample[] {
  const samples: TrainingSample[] = [];
  for (const nights of nightsByPatient) {
    if (dedupeSorted(nights).length < minNights) continue;
    samples.push({
      x: toFeatureVector(extractAdherenceFeatures(nights)),
      y: labelCompliant(nights),
    });
  }
  return samples;
}
