// PAP qualification assessment for a referral's sleep study.
//
// Encodes the Medicare PAP coverage criteria (LCD L33718 / NCD 240.4) as a
// pure, deterministic function so the referral reviewer can tell the operator
// at a glance whether the sleep study on the referral supports CPAP/BiPAP
// coverage — and, when it's the borderline 5–14 band, exactly what's needed.
//
//   * AHI (or RDI) ≥ 15 events/hour                          → qualifies
//   * AHI (or RDI) 5–14 WITH a documented comorbidity        → qualifies
//   * AHI (or RDI) 5–14 with NO documented comorbidity       → conditional
//   * AHI (or RDI) < 5                                        → not qualifying
//   * neither AHI nor RDI legible                            → unknown
//
// The qualifying value is the greater of AHI and RDI (mirrors the CMN
// clinical-justification builder, which checks "AHI or RDI"). Commercial
// payers largely mirror these thresholds, so this is a strong default
// signal — not a coverage guarantee. PHI-free: numbers + condition labels.

/** The comorbidities CMS lists as qualifying when the AHI/RDI is 5–14. */
export const QUALIFYING_COMORBIDITIES = [
  "excessive daytime sleepiness",
  "impaired cognition",
  "mood disorder",
  "insomnia",
  "hypertension",
  "ischemic heart disease",
  "history of stroke",
] as const;

export type PapQualificationVerdict =
  | "qualifies"
  | "qualifies_with_comorbidity"
  | "conditional"
  | "not_qualifying"
  | "unknown";

export interface PapQualification {
  verdict: PapQualificationVerdict;
  /** The greater of AHI and RDI; null when neither is present. */
  qualifyingValue: number | null;
  /** Which metric the qualifying value came from. */
  metric: "AHI" | "RDI" | null;
  /** True when at least one documented comorbidity was supplied. */
  hasDocumentedComorbidity: boolean;
  /** One-line operator-facing verdict. */
  summary: string;
  /** Supporting detail lines (criteria met / not met / what's needed). */
  details: string[];
}

export interface PapQualificationInput {
  ahi?: number | null;
  rdi?: number | null;
  /** Documented comorbidities pulled from the referral (any non-empty,
   *  non-whitespace entry counts as "documented"). */
  comorbidities?: Array<string | null | undefined> | null;
}

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Assess whether the supplied sleep-study metrics support Medicare PAP
 * coverage. Pure and deterministic — safe to unit-test and to call from the
 * extraction, the report renderer, and the review route alike.
 */
export function assessPapQualification(
  input: PapQualificationInput,
): PapQualification {
  const ahi = finite(input.ahi);
  const rdi = finite(input.rdi);
  const comorbidities = (input.comorbidities ?? [])
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter((c) => c.length > 0);
  const hasDocumentedComorbidity = comorbidities.length > 0;

  // The qualifying value is the greater of AHI and RDI.
  let qualifyingValue: number | null = null;
  let metric: "AHI" | "RDI" | null = null;
  if (ahi != null && rdi != null) {
    qualifyingValue = Math.max(ahi, rdi);
    metric = ahi >= rdi ? "AHI" : "RDI";
  } else if (ahi != null) {
    qualifyingValue = ahi;
    metric = "AHI";
  } else if (rdi != null) {
    qualifyingValue = rdi;
    metric = "RDI";
  }

  if (qualifyingValue == null) {
    return {
      verdict: "unknown",
      qualifyingValue: null,
      metric: null,
      hasDocumentedComorbidity,
      summary:
        "No AHI or RDI found on the sleep study — PAP qualification can't be assessed.",
      details: [
        "Obtain the diagnostic sleep study (or its AHI/RDI) from the referring provider to confirm coverage.",
      ],
    };
  }

  const shown = `${metric} ${formatIndex(qualifyingValue)}`;

  if (qualifyingValue >= 15) {
    return {
      verdict: "qualifies",
      qualifyingValue,
      metric,
      hasDocumentedComorbidity,
      summary: `${shown} (≥ 15) — meets the Medicare PAP coverage threshold.`,
      details: [
        "An AHI or RDI of at least 15 events/hour qualifies on its own (no comorbidity required).",
      ],
    };
  }

  if (qualifyingValue >= 5) {
    if (hasDocumentedComorbidity) {
      return {
        verdict: "qualifies_with_comorbidity",
        qualifyingValue,
        metric,
        hasDocumentedComorbidity,
        summary: `${shown} (5–14) with a documented comorbidity — meets the coverage criteria.`,
        details: [
          `Documented comorbidity on the referral: ${comorbidities.join(", ")}.`,
          "An AHI or RDI of 5–14 qualifies when paired with a documented comorbidity.",
        ],
      };
    }
    return {
      verdict: "conditional",
      qualifyingValue,
      metric,
      hasDocumentedComorbidity,
      summary: `${shown} (5–14) — qualifies only with a documented comorbidity; none found on the referral.`,
      details: [
        `A 5–14 AHI/RDI requires one of: ${QUALIFYING_COMORBIDITIES.join(", ")}.`,
        "No qualifying comorbidity was found in the referral — request documentation of one from the provider before dispensing.",
      ],
    };
  }

  return {
    verdict: "not_qualifying",
    qualifyingValue,
    metric,
    hasDocumentedComorbidity,
    summary: `${shown} (< 5) — does not meet the Medicare PAP AHI/RDI threshold.`,
    details: [
      "An AHI/RDI below 5 does not establish obstructive sleep apnea for PAP coverage. Confirm the study and indication with the provider.",
    ],
  };
}

/** Render an index value to one decimal, FLOORED so the shown number never
 *  rounds across a band threshold (e.g. 14.96 shows "14.9", not "15", which
 *  would contradict its "(5–14)" label). Integers render without a decimal. */
function formatIndex(n: number): string {
  const floored = Math.floor(n * 10) / 10;
  return Number.isInteger(floored) ? String(floored) : floored.toFixed(1);
}
