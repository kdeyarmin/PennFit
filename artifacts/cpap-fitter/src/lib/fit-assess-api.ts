// Client for POST /api/fit/assess — the clinical fitting assessment.
//
// WHY THIS EXISTS ALONGSIDE useGetRecommendation
// ----------------------------------------------
// `/api/recommend` is the legacy path and still serves every tenant that
// has not enabled `fitter.clinical_assessment`. `/api/fit/assess` is the
// opt-in clinical path: it reads the tenant's Mask Intelligence Catalog
// and formulary, runs the tiered engine, and records a fit session.
//
// The two speak different shapes, so `requestFitAssessment` reports which
// one answered rather than pretending they are interchangeable:
//
//   { kind: "assessment" }   the clinical path answered
//   { kind: "not_enabled" }  this tenant is on the legacy path — the
//                            caller falls back to /api/recommend
//   { kind: "safety_screen" } the tenant runs magnet screening and the
//                            patient has not completed it
//   { kind: "unavailable" }  transient — the caller must NOT fall
//                            through to /api/recommend (no magnet screen)
//
// A tenant with the flag off (`not_enabled`) still lands on the legacy
// path. A network blip or unresolvable tenant is `unavailable`: the
// results page holds the recommendation rather than skipping magnet
// screening.
//
// PRIVACY: numbers and enums only. Camera frames never leave the browser,
// and the server rejects anything that looks like encoded media.

import type { FacialMeasurements } from "@workspace/api-client-react/storefront";

const ASSESS_URL = "/api/fit/assess";

export type FitOutcome =
  | "high_confidence"
  | "moderate_confidence"
  | "low_confidence"
  | "contraindicated"
  | "outside_validated_range";

export interface FitSizeChoice {
  variantId: string;
  component: string;
  sizeCode: string;
  sizeLabel: string;
  /** Part number for this exact size — what reaches the order. */
  manufacturerPartNumber: string | null;
  bandMargin: number;
  fitDataSource: string;
  needsClinicalReview: boolean;
  measurementsUsed: string[];
  rationale: string;
}

export interface FitCandidate {
  maskSlug: string;
  maskId: string;
  name: string;
  manufacturer: string;
  interfaceType: string;
  imageUrl: string | null;
  /** Patient-facing confidence. Commercial signals never touch this. */
  confidence: number;
  cushion: FitSizeChoice | null;
  frame: FitSizeChoice | null;
  reasons: string[];
  cautions: string[];
  outsideFormulary: boolean;
  outsideFormularyReason: string | null;
  availability: string | null;
  /** Why this ranked below the primary. Empty string on the primary. */
  rankedBelowBecause: string | null;
}

export interface FitAssessment {
  outcome: FitOutcome;
  /** Null for `contraindicated` / `low_confidence` / out-of-range. */
  primary: FitCandidate | null;
  alternatives: FitCandidate[];
  excluded: Array<{
    maskSlug: string;
    maskName: string;
    tier: 1 | 2;
    code: string;
    patientReason: string;
  }>;
  recommendationConfidence: number;
  safetyFlags: string[];
  guidance: string;
  disclaimer: string;
  provenance: {
    rulesEngineVersion: string;
    formularyName: string;
    formularyVersion: number;
    degraded: boolean;
  };
  fitSessionId: string | null;
  /**
   * The service line the engine ACTUALLY filtered on. Normally the
   * population the client sent, but a chart-linked invite whose date of
   * birth disagrees is overridden server-side — the chart outranks the
   * browser. Anything filed afterwards must use THIS value, not the
   * store's. Optional: a server predating the field omits it.
   */
  population?: "adult" | "pediatric";
}

export interface SafetyScreenPrompt {
  slug: string;
  version: string;
  title: string;
  introCopy: string | null;
  attestationCopy: string;
  questions: Array<{
    questionKey: string;
    prompt: string;
    helpText: string | null;
    subject: "patient" | "household";
    sortOrder: number;
  }>;
}

export type FitAssessResult =
  | { kind: "assessment"; assessment: FitAssessment }
  | { kind: "safety_screen"; screen: SafetyScreenPrompt }
  | { kind: "not_enabled" }
  /**
   * The INVITE is dead — revoked by staff, expired, or its record is
   * gone. Distinct from "unavailable" because falling back to the legacy
   * engine here would hand the patient a recommendation from a fitting
   * their DME explicitly stopped (the legacy route's gate is a stateless
   * HMAC and cannot see revocation).
   */
  | {
      kind: "invite_invalid";
      reason: "revoked" | "expired" | "invite_not_found";
    }
  | { kind: "unavailable"; reason: string };

/**
 * Scalar scan-quality signals, mirroring the route's `scanSchema` exactly.
 *
 * Typed structurally rather than as `Record<string, unknown>` because the
 * server schema is `.strict()` — an unexpected key 400s the whole
 * assessment, so the compiler should be the one to catch it.
 */
export interface ScanSignalsRequest {
  frameCount: number;
  quality: {
    lighting?: number;
    distance?: number;
    pose?: number;
    occlusion?: number;
    motion?: number;
    framing?: number;
  };
  agreement: {
    noseWidth?: number;
    noseHeight?: number;
    noseToChin?: number;
    mouthWidth?: number;
    faceWidthAtCheekbones?: number;
  };
  measurementConfidence: number;
  band: "high" | "moderate" | "low";
  /**
   * Per-frame numbers behind the aggregate above — head angles, the
   * millimetre values that frame produced, and its own quality
   * subscores.
   *
   * The aggregate alone cannot answer why a measurement came out where
   * it did. `noseToChin` in particular carries a ~33 mm depth component
   * (nose tip to chin), so its projected length moves with head PITCH
   * roughly four times faster than the cos(pitch) model `poseCorrect`
   * applies to it — meaning a modest tilt shifts it far more than the
   * correction can account for. Distinguishing "this population
   * measures short" from "these patients were looking down at their
   * phones" needs the pitch each frame was taken at, and nothing
   * recorded it.
   *
   * PHI posture is unchanged: scalars only, exactly like the aggregate.
   * No images, no crops, no data URLs — the frames themselves never
   * leave the browser and are discarded the moment the numbers are
   * extracted.
   */
  frames?: ScanFrameRequest[];
}

/** One captured frame, as numbers. See `ScanSignalsRequest.frames`. */
export interface ScanFrameRequest {
  pose: "front" | "turn_left" | "turn_right";
  source?: "burst" | "guided";
  yawDeg: number;
  pitchDeg: number;
  /** Whether this frame cleared its own quality gates. */
  acceptable: boolean;
  /** Whether it contributed measurement samples to the aggregate. */
  contributed: boolean;
  values: {
    noseWidth?: number;
    noseHeight?: number;
    noseToChin?: number;
    mouthWidth?: number;
    faceWidthAtCheekbones?: number;
  };
  quality: {
    lighting?: number;
    distance?: number;
    pose?: number;
    occlusion?: number;
    motion?: number;
    framing?: number;
  };
  /**
   * Diagnostics, for the clinical record only — nothing in the engine
   * reads them. Pose alone cannot explain a span that reads short: too
   * far away, an iris across too few pixels to calibrate from, and a
   * depth correction that never ran are all equally consistent with it.
   */
  estimatedDistanceMm?: number;
  irisPx?: number;
  depthCorrected?: boolean;
  /** Matrix-derived head pose, or the anatomy-confounded fallback. */
  poseSource?: "matrix" | "geometric";
}

export interface FitAssessRequest {
  inviteToken: string;
  measurements: FacialMeasurements;
  /** The legacy 11 answers. Still the shape the v1 questionnaire emits. */
  answers?: Record<string, unknown>;
  /** The expanded Patient Fit Profile, when `fitter.fit_profile_v2` is on. */
  profile?: Record<string, unknown>;
  /**
   * Adult or child, from the questionnaire's population gate. Sent on
   * BOTH question sets (the profile block only travels on v2), and the
   * server applies it over whatever `buildProfile` produced — otherwise
   * every legacy-questionnaire fitting is assessed as an adult, which is
   * how a child would have been shown adult masks.
   */
  population?: "adult" | "pediatric";
  /**
   * Per-frame scan quality. Omitting it makes the route fall back to its
   * neutral default (`measurementConfidence` 0.7), which sits below the
   * high-confidence scan floor — so an omitted scan silently caps every
   * fitting at moderate.
   */
  scan?: ScanSignalsRequest;
  safety?: {
    screenVersion: string;
    attestedAt?: string;
    responses: Array<{ questionKey: string; answer: "yes" | "no" | "unsure" }>;
  };
  entryPoint?: "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign";
  signal?: AbortSignal;
}

/**
 * Ask for a clinical assessment, reporting honestly when this tenant is
 * not on the clinical path.
 *
 * Never throws. Every failure mode resolves to a result the caller can
 * act on, because the one thing a patient mid-fitting must not get is an
 * unhandled rejection where their recommendation should be.
 */
export async function requestFitAssessment(
  req: FitAssessRequest,
): Promise<FitAssessResult> {
  const body: Record<string, unknown> = { measurements: req.measurements };
  if (req.answers) body.answers = req.answers;
  if (req.profile) body.profile = req.profile;
  if (req.population) body.population = req.population;
  if (req.scan) body.scan = req.scan;
  if (req.safety) body.safety = req.safety;
  if (req.entryPoint) body.entryPoint = req.entryPoint;

  let res: Response;
  try {
    res = await fetch(ASSESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-fitter-invite-token": req.inviteToken,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }

  // 404 is the deliberate signal for "this tenant is on the legacy
  // path" — the route returns it when `fitter.clinical_assessment` is
  // off. Everything else non-2xx is a genuine failure.
  if (res.status === 404) return { kind: "not_enabled" };
  if (!res.ok) {
    return { kind: "unavailable", reason: `http_${res.status}` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { kind: "unavailable", reason: "malformed_response" };
  }
  if (!payload || typeof payload !== "object") {
    return { kind: "unavailable", reason: "malformed_response" };
  }

  // The route fails soft with 200 + `{valid:false, reason}` for tenant
  // resolution, revoked/expired invites, and a required safety screen.
  const record = payload as Record<string, unknown>;
  if (record.valid === false) {
    if (record.reason === "safety_screen_required" && record.safetyScreen) {
      return {
        kind: "safety_screen",
        screen: record.safetyScreen as SafetyScreenPrompt,
      };
    }
    if (
      record.reason === "revoked" ||
      record.reason === "expired" ||
      record.reason === "invite_not_found"
    ) {
      return { kind: "invite_invalid", reason: record.reason };
    }
    return { kind: "unavailable", reason: String(record.reason ?? "invalid") };
  }

  if (
    typeof record.outcome !== "string" ||
    !KNOWN_OUTCOMES.has(record.outcome)
  ) {
    return { kind: "unavailable", reason: "malformed_response" };
  }
  // Contract check: a non-withheld outcome always names a primary mask
  // (see FitAssessment.primary). Without this, a malformed 200 — e.g.
  // `outcome: "high_confidence"` with no primary — would put the page
  // in the clinical state with nothing to render: the withheld branch
  // doesn't match, the clinical branch has no primary, and the legacy
  // fallback never fires — skeletons forever with no retry. Treat it
  // as malformed so the caller falls back to the legacy engine.
  if (
    !isWithheld(record.outcome as FitOutcome) &&
    (typeof record.primary !== "object" || record.primary === null)
  ) {
    return { kind: "unavailable", reason: "malformed_response" };
  }
  return { kind: "assessment", assessment: record as unknown as FitAssessment };
}

/**
 * Project an assessment onto the legacy `topRecommendations` shape.
 *
 * The results page renders a ranked list of cards, and rebuilding that
 * around the clinical shape would mean two parallel renderers to keep in
 * sync. Adapting instead keeps ONE card renderer; the clinical extras the
 * legacy shape has no room for — exception state, size, ranking reasons,
 * formulary provenance — are surfaced separately by the page.
 *
 * A withheld primary (`low_confidence`, `contraindicated`,
 * `outside_validated_range`) intentionally yields an EMPTY list. The
 * engine declining to name a mask is the point of confidence gating, and
 * quietly promoting an alternative into its place would undo it.
 */
export function assessmentToLegacyRecommendations(
  assessment: FitAssessment,
): Array<{
  maskId: string;
  name: string;
  type: string;
  manufacturer: string;
  confidence: number;
  imageUrl: string | null;
  sizeLabel: string | null;
  reasons: string[];
  cautions: string[];
  rankedBelowBecause: string | null;
}> {
  if (!assessment.primary) return [];
  return [assessment.primary, ...assessment.alternatives].map((c) => ({
    maskId: c.maskSlug,
    name: c.name,
    type: c.interfaceType,
    manufacturer: c.manufacturer,
    confidence: c.confidence,
    imageUrl: c.imageUrl,
    sizeLabel: c.cushion?.sizeLabel ?? c.frame?.sizeLabel ?? null,
    reasons: c.reasons,
    cautions: c.cautions,
    rankedBelowBecause: c.rankedBelowBecause,
  }));
}

/**
 * Collapse a clinical interface type onto the four legacy mask types.
 *
 * The staff worklist and the campaign-enrollment ping both speak the v1
 * vocabulary, and they must keep receiving fittings from the clinical
 * path. The catalog draws finer distinctions than v1 has words for
 * (`nasal_cradle`, `total_face`, `oral`), so each maps to its nearest v1
 * neighbour rather than being dropped — a coarser label reaching staff
 * beats no record of the fitting at all.
 */
export function toLegacyMaskType(
  interfaceType: string,
): "nasal" | "nasalPillow" | "fullFace" | "hybrid" {
  switch (interfaceType) {
    case "nasal_pillow":
    case "nasal_cradle":
      return "nasalPillow";
    case "hybrid":
      return "hybrid";
    case "full_face":
    case "total_face":
    case "oral":
      return "fullFace";
    case "nasal":
    default:
      return "nasal";
  }
}

/** Every outcome the route can emit — used to reject a malformed 200
 *  (unknown outcome string) instead of casting it into the UI. */
const KNOWN_OUTCOMES: ReadonlySet<string> = new Set([
  "high_confidence",
  "moderate_confidence",
  "low_confidence",
  "contraindicated",
  "outside_validated_range",
] satisfies FitOutcome[]);

/** True when the engine deliberately withheld an automated recommendation. */
export function isWithheld(outcome: FitOutcome): boolean {
  return (
    outcome === "low_confidence" ||
    outcome === "contraindicated" ||
    outcome === "outside_validated_range"
  );
}
