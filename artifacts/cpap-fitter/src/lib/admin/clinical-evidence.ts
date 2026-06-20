// Maps a clinical smart-trigger kind to the therapy metric whose trend
// is the *evidence* for why that signal fired, and slices a patient's
// nights down to the rule's detection window. Pure + dependency-free so
// the patient-detail card stays a thin renderer and the mapping is
// unit-tested.
//
// Only the CLINICAL (RT-owned) kinds have evidence here — the
// patient-facing nudge kinds (leak_rising, …) already get the full
// 60-night Therapy-trends card and don't need a per-signal cutout.

export type ClinicalEvidenceKind =
  | "pressure_at_max"
  | "ahi_elevated"
  | "non_adherent_30d"
  | "ahi_rising"
  | "usage_erratic";

/** The night fields the evidence accessors read (a subset of the
 *  patient-detail TherapyNight shape). */
export interface EvidenceNight {
  nightDate: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
}

interface EvidenceMetric {
  /** Short label for the cutout, e.g. "P95 pressure". */
  label: string;
  /** Unit suffix shown after the latest value. */
  unit: string;
  /** Sparkline stroke colour. */
  color: string;
  /** Pull the plotted value (already in display units) from a night. */
  accessor: (n: EvidenceNight) => number | null;
}

const USAGE_HOURS = (n: EvidenceNight): number | null =>
  n.usageMinutes == null ? null : n.usageMinutes / 60;

export const CLINICAL_EVIDENCE_METRIC: Record<
  ClinicalEvidenceKind,
  EvidenceMetric
> = {
  // Pressure pegging — the P95 pressure trend is the evidence.
  pressure_at_max: {
    label: "P95 pressure",
    unit: "cmH₂O",
    color: "#7c3aed",
    accessor: (n) => n.pressureP95Cmh2o,
  },
  // AHI level alarm + early-warning trend — both plot residual AHI.
  ahi_elevated: {
    label: "AHI",
    unit: "/h",
    color: "#b45309",
    accessor: (n) => n.ahi,
  },
  ahi_rising: {
    label: "AHI",
    unit: "/h",
    color: "#b45309",
    accessor: (n) => n.ahi,
  },
  // Adherence signals — nightly usage hours.
  non_adherent_30d: {
    label: "Usage",
    unit: "h",
    color: "hsl(var(--penn-navy))",
    accessor: USAGE_HOURS,
  },
  usage_erratic: {
    label: "Usage",
    unit: "h",
    color: "hsl(var(--penn-navy))",
    accessor: USAGE_HOURS,
  },
};

export interface EvidenceSeries {
  label: string;
  unit: string;
  color: string;
  /** Oldest → newest within the detection window. Nulls = missing
   *  nights (the Sparkline breaks the line at gaps). */
  values: Array<number | null>;
  /** Latest non-null value in the window, for the headline number. */
  latest: number | null;
  /** Count of nights with a value in the window. */
  sampleCount: number;
}

/**
 * Build the evidence series for one clinical signal: the metric that
 * fired, sliced to the rule's detection window and ordered oldest →
 * newest. `nights` may arrive in any order; window bounds are inclusive
 * YYYY-MM-DD strings (lexical compare is correct for that format).
 *
 * Returns null for a non-clinical kind (no per-signal evidence).
 */
export function buildClinicalEvidenceSeries(
  kind: string,
  nights: ReadonlyArray<EvidenceNight>,
  windowStartDate: string,
  windowEndDate: string,
): EvidenceSeries | null {
  const metric = CLINICAL_EVIDENCE_METRIC[kind as ClinicalEvidenceKind];
  if (!metric) return null;

  const inWindow = nights
    .filter(
      (n) => n.nightDate >= windowStartDate && n.nightDate <= windowEndDate,
    )
    .sort((a, b) => a.nightDate.localeCompare(b.nightDate));

  const values = inWindow.map((n) => metric.accessor(n));
  let latest: number | null = null;
  let sampleCount = 0;
  for (const v of values) {
    if (v != null) {
      latest = v;
      sampleCount += 1;
    }
  }

  return {
    label: metric.label,
    unit: metric.unit,
    color: metric.color,
    values,
    latest,
    sampleCount,
  };
}
