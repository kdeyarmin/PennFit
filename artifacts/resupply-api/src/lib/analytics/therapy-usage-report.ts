// Therapy-usage report — pure aggregation helper.
//
// Powers GET /admin/reports/therapy-usage, the provider-facing
// "snapshot of therapy adherence" that marketing/sales presents to a
// referring physician. The same projection rolls up three ways —
// `by patient`, `by provider`, or `by manufacturer` — so the route
// hands us a flat list of per-night rows already tagged with the
// grouping key/label and we reduce them here.
//
// PURE: no DB, no Date.now(), no logging (mirrors aggregate.ts). The
// route owns the Supabase reads + the join that produces the tagged
// rows; this module is the math, which keeps it unit-testable without
// a Supabase mock and reusable from a future scheduled-export job.
//
// Adherence math reuses the CMS threshold constants from
// compliance-attestation.ts so this report and the on-file attestation
// can never drift apart on "what counts as a compliant night".

import {
  COMPLIANT_MINUTES_PER_NIGHT,
  COMPLIANCE_NIGHT_RATIO,
} from "../compliance-attestation";

/** The three axes a report can be pulled along. */
export const THERAPY_REPORT_GROUPINGS = [
  "patient",
  "provider",
  "manufacturer",
] as const;
export type TherapyReportGrouping = (typeof THERAPY_REPORT_GROUPINGS)[number];

/** One night of therapy for one patient, pre-tagged by the route with
 *  the grouping bucket it belongs to. A single patient can appear under
 *  multiple buckets when grouping by provider (multiple prescribers) or
 *  manufacturer (multiple devices); the aggregation counts distinct
 *  patients per bucket so those are not double-counted. */
export interface TherapyNightRow {
  /** Stable identifier for the bucket (patient id / provider id /
   *  manufacturer name). Rows with the same key roll up together. */
  groupKey: string;
  /** Human-facing bucket name (patient initials, provider legal name,
   *  manufacturer). */
  groupLabel: string;
  /** Optional secondary line (NPI + practice, device model, …). */
  groupSublabel?: string | null;
  patientId: string;
  /** Null when the night reported metadata but no usage minutes. Null
   *  is treated as 0 for adherence (matches compliance-attestation). */
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
}

export interface TherapyUsageGroup {
  key: string;
  label: string;
  sublabel: string | null;
  /** Distinct patients with ≥1 night of data in this bucket. */
  patientCount: number;
  /** Nights of data in this bucket (rows). */
  nightsWithData: number;
  /** Mean nightly use across all nights, in hours, 1 decimal. Null
   *  when the bucket has no nights. */
  avgUsageHours: number | null;
  /** Mean AHI across nights that reported an AHI, 1 decimal. */
  avgAhi: number | null;
  /** Mean large-leak rate across nights that reported one, 1 decimal. */
  avgLeakRateLMin: number | null;
  /** Share of nights at or above the 4-hour CMS threshold, 0..1, 4
   *  decimals. Null when no nights. */
  adherentNightRate: number | null;
  /** Patients whose compliant-night share meets the CMS ratio
   *  (≥70% of their nights ≥4h). */
  cmsCompliantPatients: number;
  /** cmsCompliantPatients / patientCount, 0..1, 4 decimals. */
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

interface PatientAccumulator {
  nights: number;
  adherentNights: number;
}

interface BucketAccumulator {
  label: string;
  sublabel: string | null;
  nights: number;
  adherentNights: number;
  usageSum: number;
  usageNights: number;
  ahiSum: number;
  ahiNights: number;
  leakSum: number;
  leakNights: number;
  /** Per-patient night/adherent tallies for the CMS-compliant count. */
  patients: Map<string, PatientAccumulator>;
}

function isCmsCompliant(acc: PatientAccumulator): boolean {
  if (acc.nights === 0) return false;
  return acc.adherentNights / acc.nights >= COMPLIANCE_NIGHT_RATIO;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(sum: number, count: number, decimals: number): number | null {
  return count > 0 ? round(sum / count, decimals) : null;
}

export function aggregateTherapyUsageReport(
  grouping: TherapyReportGrouping,
  rows: TherapyNightRow[],
): TherapyUsageReportResult {
  const buckets = new Map<string, BucketAccumulator>();
  // Global per-patient tallies for the deduped summary line.
  const globalPatients = new Map<string, PatientAccumulator>();

  for (const row of rows) {
    const usage = row.usageMinutes ?? 0;
    const adherent = usage >= COMPLIANT_MINUTES_PER_NIGHT;

    let bucket = buckets.get(row.groupKey);
    if (!bucket) {
      bucket = {
        label: row.groupLabel,
        sublabel: row.groupSublabel ?? null,
        nights: 0,
        adherentNights: 0,
        usageSum: 0,
        usageNights: 0,
        ahiSum: 0,
        ahiNights: 0,
        leakSum: 0,
        leakNights: 0,
        patients: new Map(),
      };
      buckets.set(row.groupKey, bucket);
    }

    bucket.nights += 1;
    if (adherent) bucket.adherentNights += 1;
    if (row.usageMinutes != null) {
      bucket.usageSum += row.usageMinutes;
      bucket.usageNights += 1;
    }
    if (row.ahi != null) {
      bucket.ahiSum += row.ahi;
      bucket.ahiNights += 1;
    }
    if (row.leakRateLMin != null) {
      bucket.leakSum += row.leakRateLMin;
      bucket.leakNights += 1;
    }

    const tally = (map: Map<string, PatientAccumulator>) => {
      let p = map.get(row.patientId);
      if (!p) {
        p = { nights: 0, adherentNights: 0 };
        map.set(row.patientId, p);
      }
      p.nights += 1;
      if (adherent) p.adherentNights += 1;
    };
    tally(bucket.patients);
    tally(globalPatients);
  }

  const groups: TherapyUsageGroup[] = [];
  for (const [key, b] of buckets) {
    let cmsCompliant = 0;
    for (const p of b.patients.values()) {
      if (isCmsCompliant(p)) cmsCompliant += 1;
    }
    const patientCount = b.patients.size;
    groups.push({
      key,
      label: b.label,
      sublabel: b.sublabel,
      patientCount,
      nightsWithData: b.nights,
      avgUsageHours: mean(b.usageSum / 60, b.usageNights, 1),
      avgAhi: mean(b.ahiSum, b.ahiNights, 1),
      avgLeakRateLMin: mean(b.leakSum, b.leakNights, 1),
      adherentNightRate:
        b.nights > 0 ? round(b.adherentNights / b.nights, 4) : null,
      cmsCompliantPatients: cmsCompliant,
      cmsComplianceRate:
        patientCount > 0 ? round(cmsCompliant / patientCount, 4) : null,
    });
  }

  groups.sort(
    (a, b) =>
      b.patientCount - a.patientCount || a.label.localeCompare(b.label),
  );

  // Summary aggregates the raw rows once more (not the rounded group
  // values) so it stays exact rather than an average-of-averages.
  let nights = 0;
  let adherentNights = 0;
  let usageSum = 0;
  let usageNights = 0;
  let ahiSum = 0;
  let ahiNights = 0;
  let leakSum = 0;
  let leakNights = 0;
  for (const row of rows) {
    nights += 1;
    if ((row.usageMinutes ?? 0) >= COMPLIANT_MINUTES_PER_NIGHT) {
      adherentNights += 1;
    }
    if (row.usageMinutes != null) {
      usageSum += row.usageMinutes;
      usageNights += 1;
    }
    if (row.ahi != null) {
      ahiSum += row.ahi;
      ahiNights += 1;
    }
    if (row.leakRateLMin != null) {
      leakSum += row.leakRateLMin;
      leakNights += 1;
    }
  }
  let cmsCompliant = 0;
  for (const p of globalPatients.values()) {
    if (isCmsCompliant(p)) cmsCompliant += 1;
  }
  const patientCount = globalPatients.size;

  return {
    grouping,
    summary: {
      patientCount,
      nightsWithData: nights,
      avgUsageHours: mean(usageSum / 60, usageNights, 1),
      avgAhi: mean(ahiSum, ahiNights, 1),
      avgLeakRateLMin: mean(leakSum, leakNights, 1),
      adherentNightRate: nights > 0 ? round(adherentNights / nights, 4) : null,
      cmsCompliantPatients: cmsCompliant,
      cmsComplianceRate:
        patientCount > 0 ? round(cmsCompliant / patientCount, 4) : null,
    },
    groups,
  };
}
