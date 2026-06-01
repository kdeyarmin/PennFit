// Therapy-usage report — pure aggregation helper.
//
// Powers GET /admin/reports/therapy-usage, the provider-facing
// "snapshot of therapy adherence" that marketing/sales presents to a
// referring physician. The same projection rolls up three ways —
// `by patient`, `by provider`, or `by manufacturer`.
//
// PURE: no DB, no Date.now(), no logging (mirrors aggregate.ts). The
// route owns the Supabase reads, the numeric coercion (ahi/leak are
// `numeric` → PostgREST strings), and the source-priority dedupe of
// `patient_therapy_nights` (UNIQUE(patient_id, night_date, source)
// permits several rows per patient/night). This module is the math.
//
// Two correctness properties the route depends on us upholding:
//
//   1. A patient can belong to several buckets (multiple prescribers,
//      multiple devices). Their nights are counted IN each bucket
//      (a provider's cohort genuinely includes all of that patient's
//      nights), but the headline SUMMARY counts every patient — and
//      every night — exactly once.
//   2. "CMS compliant" means the real CMS rule (≥4h on ≥70% of nights
//      across a consecutive 30-day window), evaluated per patient with
//      the same vetted `findBestAdherenceWindow` helper — NOT "≥70% of
//      whatever rows happened to land in the window". Because this is a
//      *current-adherence* snapshot (not the one-time Medicare initial-
//      90-day attestation), the probe is anchored to the RECENT 90-day
//      horizon (see step 2 below), so a long report window can't make
//      the headline reflect compliance from months ago. That keeps a
//      physician-facing compliance share both honest and current.

import {
  findBestAdherenceWindow,
  COMPLIANT_MINUTES_PER_NIGHT,
  ATTESTATION_HORIZON_DAYS,
  type AdherenceNight,
} from "../compliance-attestation";

/** The three axes a report can be pulled along. */
export const THERAPY_REPORT_GROUPINGS = [
  "patient",
  "provider",
  "manufacturer",
] as const;
export type TherapyReportGrouping = (typeof THERAPY_REPORT_GROUPINGS)[number];

/** A bucket a patient rolls up into (its key/label come from the route's
 *  join: patient id, provider row, or manufacturer string). */
export interface GroupRef {
  key: string;
  label: string;
  sublabel?: string | null;
}

/** One source-deduped night for one patient. Numerics are already
 *  coerced to `number | null` by the route. */
export interface PatientNight {
  patientId: string;
  /** YYYY-MM-DD. At most one row per (patientId, date) — the route
   *  collapses multi-source nights by source priority first. */
  date: string;
  /** Null when the night reported metadata but no usage minutes; the
   *  CMS rule treats null as 0. */
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
}

export interface AggregateTherapyUsageInput {
  grouping: TherapyReportGrouping;
  /** Source-deduped nights (one per patient/date). */
  nights: PatientNight[];
  /** patient id → the bucket(s) that patient belongs to. A patient
   *  absent from the map (no provider / no device) is dropped from a
   *  provider/manufacturer report; for the patient grouping the route
   *  maps every patient to a single self-bucket. */
  bucketsByPatient: Map<string, GroupRef[]>;
  /** Evaluation date (YYYY-MM-DD) for the CMS window search. */
  asOfDate: string;
}

export interface TherapyUsageGroup {
  key: string;
  label: string;
  sublabel: string | null;
  /** Distinct patients with ≥1 night of data in this bucket. */
  patientCount: number;
  /** Nights of data in this bucket. */
  nightsWithData: number;
  /** Mean nightly use across all nights, in hours, 1 decimal. */
  avgUsageHours: number | null;
  /** Mean AHI across nights that reported an AHI, 1 decimal. */
  avgAhi: number | null;
  /** Mean large-leak rate across nights that reported one, 1 decimal. */
  avgLeakRateLMin: number | null;
  /** Share of nights at or above the 4-hour threshold, 0..1, 4 dp. */
  adherentNightRate: number | null;
  /** Patients with a qualifying CMS 30-day adherence window. */
  cmsCompliantPatients: number;
  /** cmsCompliantPatients / patientCount, 0..1, 4 dp. */
  cmsComplianceRate: number | null;
}

export interface TherapyUsageSummary {
  /** Distinct patients across every bucket (deduped globally). */
  patientCount: number;
  nightsWithData: number;
  avgUsageHours: number | null;
  avgAhi: number | null;
  avgLeakRateLMin: number | null;
  adherentNightRate: number | null;
  cmsCompliantPatients: number;
  cmsComplianceRate: number | null;
}

export interface TherapyUsageReportResult {
  grouping: TherapyReportGrouping;
  summary: TherapyUsageSummary;
  /** Buckets sorted by patientCount desc, then label asc. */
  groups: TherapyUsageGroup[];
}

interface MetricAccumulator {
  nights: number;
  adherentNights: number;
  usageSum: number;
  usageNights: number;
  ahiSum: number;
  ahiNights: number;
  leakSum: number;
  leakNights: number;
}

interface BucketAccumulator extends MetricAccumulator {
  label: string;
  sublabel: string | null;
  /** Distinct patient ids seen in this bucket. */
  patients: Set<string>;
  /** Of those, the ones that are CMS-compliant. */
  cmsCompliantPatients: Set<string>;
}

function newMetrics(): MetricAccumulator {
  return {
    nights: 0,
    adherentNights: 0,
    usageSum: 0,
    usageNights: 0,
    ahiSum: 0,
    ahiNights: 0,
    leakSum: 0,
    leakNights: 0,
  };
}

function addNight(acc: MetricAccumulator, night: PatientNight): void {
  acc.nights += 1;
  if ((night.usageMinutes ?? 0) >= COMPLIANT_MINUTES_PER_NIGHT) {
    acc.adherentNights += 1;
  }
  if (night.usageMinutes != null) {
    acc.usageSum += night.usageMinutes;
    acc.usageNights += 1;
  }
  if (night.ahi != null) {
    acc.ahiSum += night.ahi;
    acc.ahiNights += 1;
  }
  if (night.leakRateLMin != null) {
    acc.leakSum += night.leakRateLMin;
    acc.leakNights += 1;
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(sum: number, count: number, decimals: number): number | null {
  return count > 0 ? round(sum / count, decimals) : null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

/** `isoDate` (YYYY-MM-DD) shifted back `days` calendar days, in UTC.
 *  Pure: derived only from the passed date, never Date.now(). */
function isoDaysBefore(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function aggregateTherapyUsageReport(
  input: AggregateTherapyUsageInput,
): TherapyUsageReportResult {
  const { grouping, nights, bucketsByPatient, asOfDate } = input;

  // 1. Group the deduped nights by patient.
  const nightsByPatient = new Map<string, PatientNight[]>();
  for (const night of nights) {
    let arr = nightsByPatient.get(night.patientId);
    if (!arr) {
      arr = [];
      nightsByPatient.set(night.patientId, arr);
    }
    arr.push(night);
  }

  // 2. Compute CMS compliance ONCE per patient using the real rule:
  //    findBestAdherenceWindow searches for a qualifying 30-day window
  //    (≥4h on ≥70% of calendar days) in a 90-day probe horizon. It only
  //    ever examines 90 days starting at its anchor, so the anchor choice
  //    decides WHICH 90 days are scored.
  //
  //    We anchor to the RECENT horizon — (asOf − 89 days), clamped
  //    forward to the patient's earliest pulled night — NOT to the first
  //    pulled night. Anchoring at the first pulled night made a 180/365-
  //    day report score the OLDEST 90 days of the window (compliance as
  //    of many months ago) instead of how the patient is doing now. This
  //    report is a current-adherence snapshot, so we probe the most
  //    recent 90 days; a qualifying 30-day window inside that horizon is
  //    what "CMS compliant" means here. (This is intentionally distinct
  //    from the on-file Medicare initial-90-day-of-therapy attestation,
  //    which anchors at the patient's true therapy start.)
  const recentHorizonStart = isoDaysBefore(
    asOfDate,
    ATTESTATION_HORIZON_DAYS - 1,
  );
  const cmsCompliantPatient = new Set<string>();
  for (const [patientId, patientNights] of nightsByPatient) {
    const adherenceNights: AdherenceNight[] = patientNights
      .map((n) => ({ date: n.date, usageMinutes: n.usageMinutes }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const earliest = adherenceNights[0]?.date;
    if (!earliest) continue;
    // ISO date strings compare lexicographically; take the later of the
    // recent-horizon start and the patient's first pulled night.
    const anchorDate =
      earliest > recentHorizonStart ? earliest : recentHorizonStart;
    const result = findBestAdherenceWindow(
      adherenceNights,
      anchorDate,
      asOfDate,
    );
    if (result.qualifies) cmsCompliantPatient.add(patientId);
  }

  // 3. Per-bucket metrics: fan each patient's nights into every bucket
  //    they belong to (a cohort genuinely contains all those nights).
  const buckets = new Map<string, BucketAccumulator>();
  for (const [patientId, patientNights] of nightsByPatient) {
    const refs = bucketsByPatient.get(patientId);
    if (!refs || refs.length === 0) continue;
    const isCompliant = cmsCompliantPatient.has(patientId);
    for (const ref of refs) {
      let bucket = buckets.get(ref.key);
      if (!bucket) {
        bucket = {
          ...newMetrics(),
          label: ref.label,
          sublabel: ref.sublabel ?? null,
          patients: new Set(),
          cmsCompliantPatients: new Set(),
        };
        buckets.set(ref.key, bucket);
      }
      bucket.patients.add(patientId);
      if (isCompliant) bucket.cmsCompliantPatients.add(patientId);
      for (const night of patientNights) addNight(bucket, night);
    }
  }

  const groups: TherapyUsageGroup[] = [];
  for (const [key, b] of buckets) {
    const patientCount = b.patients.size;
    const cmsCount = b.cmsCompliantPatients.size;
    groups.push({
      key,
      label: b.label,
      sublabel: b.sublabel,
      patientCount,
      nightsWithData: b.nights,
      avgUsageHours: mean(b.usageSum / 60, b.usageNights, 1),
      avgAhi: mean(b.ahiSum, b.ahiNights, 1),
      avgLeakRateLMin: mean(b.leakSum, b.leakNights, 1),
      adherentNightRate: rate(b.adherentNights, b.nights),
      cmsCompliantPatients: cmsCount,
      cmsComplianceRate: rate(cmsCount, patientCount),
    });
  }
  groups.sort(
    (a, b) => b.patientCount - a.patientCount || a.label.localeCompare(b.label),
  );

  // 4. Summary aggregates each deduped night ONCE (never fanned out),
  //    so a patient in multiple buckets isn't double-counted.
  const summaryMetrics = newMetrics();
  for (const patientNights of nightsByPatient.values()) {
    for (const night of patientNights) addNight(summaryMetrics, night);
  }
  const summaryPatientCount = nightsByPatient.size;

  return {
    grouping,
    summary: {
      patientCount: summaryPatientCount,
      nightsWithData: summaryMetrics.nights,
      avgUsageHours: mean(
        summaryMetrics.usageSum / 60,
        summaryMetrics.usageNights,
        1,
      ),
      avgAhi: mean(summaryMetrics.ahiSum, summaryMetrics.ahiNights, 1),
      avgLeakRateLMin: mean(
        summaryMetrics.leakSum,
        summaryMetrics.leakNights,
        1,
      ),
      adherentNightRate: rate(
        summaryMetrics.adherentNights,
        summaryMetrics.nights,
      ),
      cmsCompliantPatients: cmsCompliantPatient.size,
      cmsComplianceRate: rate(cmsCompliantPatient.size, summaryPatientCount),
    },
    groups,
  };
}
