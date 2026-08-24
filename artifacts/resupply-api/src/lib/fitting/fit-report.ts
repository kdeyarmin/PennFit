/**
 * The clinical fit report — a pure projection from a stored fit session.
 *
 * This is the artifact that makes the fitter defensible to a sleep lab, a
 * respiratory therapist, a physician, or a payer. It answers, months
 * later: what was measured, how good the measurement was, what the patient
 * told us, what we screened for, what we recommended, what we ruled out
 * and why, which catalog and formulary version were in force, which rules
 * engine ran, who approved or overrode it, and what was finally dispensed.
 *
 * Two things this module is careful about:
 *
 *   1. It reads STORED provenance and never recomputes. A report reprinted
 *      a year from now must show the rules that actually ran, not today's.
 *   2. `redactForPatient()` strips the commercial layer. A patient must
 *      never read "excluded: margin — steer to the house brand". The
 *      redaction is enumerated and unit-tested rather than left to the
 *      care of whoever writes the next template.
 */

import type { Json } from "@workspace/resupply-db";

import type {
  ExclusionRecord,
  FitCandidate,
  FitOutcome,
  FitProfile,
} from "./types.js";

/** One reviewed size band, and the evidence behind it. */
export interface GeometrySignOff {
  /** "cushion" / "frame" — which part of the mask this size is. */
  component: string;
  sizeLabel: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  /** Class of evidence; null on sign-offs predating migration 0491. */
  sourceKind: string | null;
  /** The pointer itself — document + revision, URL, or how it was measured. */
  sourceRef: string | null;
}

export interface FitReportHeader {
  practiceName: string;
  locationName: string | null;
  generatedAt: string;
  reportId: string;
}

export interface FitReportPatient {
  name: string | null;
  dateOfBirth: string | null;
  patientRef: string | null;
}

export interface FitReportCapture {
  scanDateTime: string;
  frameCount: number;
  calibrationMethod: string | null;
  measurementConfidence: number | null;
  band: "high" | "moderate" | "low" | null;
  grade: "good" | "marginal" | "poor" | null;
  quality: Record<string, number>;
  agreement: Record<string, number>;
}

export interface FitReportSafety {
  screenVersion: string | null;
  attestedAt: string | null;
  attestationCopy: string | null;
  responses: Array<{
    prompt: string;
    subject: "patient" | "household";
    answer: "yes" | "no" | "unsure";
  }>;
  flags: string[];
}

export interface FitReportReview {
  status: string;
  reviewerEmail: string | null;
  reviewedAt: string | null;
  decision: string | null;
  overrideFrom: string | null;
  overrideTo: string | null;
  overrideReason: string | null;
  /** Why a rescan was requested (0501). Null before the column existed. */
  rescanReason: string | null;
}

export interface FitReportDispensing {
  orderedMask: string | null;
  orderedSize: string | null;
  orderId: string | null;
  dispensedAt: string | null;
}

export interface FitReportEvent {
  eventType: string;
  actorKind: string;
  actorEmail: string | null;
  occurredAt: string;
  detail: Json | null;
}

export interface FitReport {
  header: FitReportHeader;
  patient: FitReportPatient;
  session: {
    id: string;
    createdAt: string;
    population: string;
    serviceLine: string;
    entryPoint: string;
    outcome: FitOutcome | null;
    confidence: number | null;
    guidance: string;
  };
  capture: FitReportCapture;
  measurements: Record<string, number>;
  profile: Array<{ question: string; answer: string }>;
  safety: FitReportSafety;
  primary: FitCandidate | null;
  alternatives: FitCandidate[];
  excluded: ExclusionRecord[];
  provenance: {
    rulesEngineVersion: string;
    catalogSnapshotVersion: number | null;
    formularyName: string | null;
    formularyVersion: number | null;
    formularyRulesMatched: Json | null;
    /**
     * Slugs the formulary hard-excluded — masks the provider does not
     * carry (migrations 0516/0517). NULL on sessions written before the
     * column existed, which reads as "not recorded" rather than "nothing
     * was hidden".
     */
    formularyExcludedSlugs: string[] | null;
    degraded: boolean;
    /**
     * Clinical sign-off on the millimetre bands this fitting was measured
     * against, for the sizes it actually used (migration 0491).
     *
     * This is the evidence behind the geometry. Without it the report
     * asserts a size was right; with it a later reader — an RT, an
     * auditor, a payer — can see WHAT the band was checked against and by
     * whom. Empty when the catalog rows carry no tenant sign-off, which
     * is itself worth printing: it means the fitting ran on the seeded
     * estimates.
     */
    geometrySignOff: GeometrySignOff[];
  };
  review: FitReportReview;
  dispensing: FitReportDispensing;
  auditTrail: FitReportEvent[];
  disclaimer: string;
}

const MEASUREMENT_LABELS: Record<string, string> = {
  noseWidth: "Nose width",
  noseHeight: "Nose height",
  noseToChin: "Nose to chin",
  mouthWidth: "Mouth width",
  faceWidthAtCheekbones: "Face width at cheekbones",
};

export function measurementLabel(key: string): string {
  return MEASUREMENT_LABELS[key] ?? key;
}

const PROFILE_QUESTIONS: Array<{
  key: keyof FitProfile;
  question: string;
  format?: (v: unknown) => string;
}> = [
  { key: "therapyDevice", question: "Prescribed therapy device" },
  { key: "therapyMode", question: "Therapy mode" },
  {
    key: "pressureCmH2O",
    question: "Prescribed pressure",
    format: (v) => (typeof v === "number" ? `${v} cmH2O` : "Not known"),
  },
  { key: "pressureBand", question: "Pressure range" },
  { key: "supplementalOxygen", question: "Uses supplemental oxygen" },
  { key: "mouthBreather", question: "Breathes through the mouth while asleep" },
  { key: "nasalObstruction", question: "Nasal obstruction or congestion" },
  { key: "dryMouth", question: "Dry mouth on waking" },
  {
    key: "sleepPositions",
    question: "Sleeping position",
    format: (v) =>
      Array.isArray(v) && v.length > 0 ? v.join(", ") : "Not stated",
  },
  { key: "claustrophobia", question: "Claustrophobia" },
  { key: "minimalContactPreference", question: "Minimal-contact preference" },
  { key: "facialHair", question: "Facial hair" },
  { key: "dentures", question: "Dentures" },
  { key: "facialStructureChange", question: "Change in facial structure" },
  { key: "skinIrritation", question: "Skin irritation or pressure sores" },
  { key: "siliconeSensitivity", question: "Silicone sensitivity" },
  { key: "wearsGlasses", question: "Wears glasses in bed" },
  { key: "priorMaskExperience", question: "Previous mask type" },
  { key: "priorMaskSize", question: "Previous mask size" },
  {
    key: "priorLeakLocations",
    question: "Where the previous mask leaked",
    format: (v) =>
      Array.isArray(v) && v.length > 0
        ? v.map((x) => String(x).replace(/_/g, " ")).join(", ")
        : "Not stated",
  },
  {
    key: "priorMaskSatisfaction",
    question: "Satisfaction with the previous mask",
    format: (v) => (typeof v === "number" ? `${v} out of 5` : "Not stated"),
  },
  {
    key: "headgearDifficulty",
    question: "Difficulty applying or removing headgear",
  },
  { key: "handDexterity", question: "Hand dexterity" },
  {
    key: "visionOrCognitiveLimitation",
    question: "Vision or cognitive limitation",
  },
];

function formatAnswer(value: unknown): string {
  if (value === null || value === undefined) return "Not answered";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Not stated";
  }
  if (typeof value === "string") {
    // Enum values are snake_case on the wire and sentence case on paper.
    const spaced = value.replace(/_/g, " ");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }
  return String(value);
}

/** Render the stored profile as question/answer pairs, in a fixed order. */
export function profileAsQA(
  profile: Partial<FitProfile> | null,
): Array<{ question: string; answer: string }> {
  if (!profile) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const spec of PROFILE_QUESTIONS) {
    const raw = profile[spec.key];
    // Skip questions the patient was never asked, rather than printing a
    // wall of "Not answered" for a v1 session.
    if (raw === undefined) continue;
    out.push({
      question: spec.question,
      answer: spec.format ? spec.format(raw) : formatAnswer(raw),
    });
  }
  return out;
}

/**
 * Fields that must never reach a patient-facing copy of the report.
 *
 * These are the commercial and internal-clinical layer: which formulary
 * rules fired, why a mask was demoted, who reviewed it. Enumerated here so
 * the redaction is one reviewable list rather than scattered conditionals.
 */
export const PATIENT_REDACTED_FIELDS = [
  "formularyRulesMatched",
  "formularyExcludedSlugs",
  "outsideFormularyReason",
  "reasonNote",
  "marginRank",
  "reviewerEmail",
  "clinicianReason",
] as const;

/**
 * Strip the report down to what a patient should see.
 *
 * Keeps the clinical substance — measurements, scan quality, safety
 * screening, the recommendation and its alternatives, the plain-language
 * reasons — and removes the provider's commercial configuration and staff
 * identities.
 */
export function redactForPatient(report: FitReport): FitReport {
  const stripCandidate = (c: FitCandidate): FitCandidate => ({
    ...c,
    outsideFormularyReason: null,
  });

  return {
    ...report,
    primary: report.primary ? stripCandidate(report.primary) : null,
    alternatives: report.alternatives.map(stripCandidate),
    // A patient sees THAT something was ruled out and the plain-language
    // reason, never the clinician-facing detail.
    excluded: report.excluded.map((e) => ({
      ...e,
      clinicianReason: e.patientReason,
    })),
    provenance: {
      ...report.provenance,
      formularyRulesMatched: null,
      // A list of what their provider chose not to stock is exactly what
      // hiding those masks was meant to keep off a patient's screen.
      formularyExcludedSlugs: null,
    },
    review: {
      ...report.review,
      reviewerEmail: null,
      // Clinician-authored working notes stay staff-side.
      rescanReason: null,
    },
    // The event trail names staff members and carries internal codes.
    auditTrail: [],
  };
}

export const FIT_REPORT_DISCLAIMER =
  "This report records a facial-measurement-based sizing assessment, not a clinical fitting. " +
  "Measurements are derived on the patient's own device from a camera image that is never transmitted or stored; " +
  "only the resulting numbers are sent. The recommendation is advisory and is confirmed by the dispensing provider.";
