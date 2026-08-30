/**
 * Pure helpers for the /measure → /questionnaire flow. Lives in its own
 * file so we can unit-test the routing invariant and the measurement
 * plausibility window without dragging in MediaPipe / camera / DOM.
 */
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import type { ExtractionFailReason } from "./face-measurements";
import {
  COACH_COPY,
  DISTANCE_COACH_COPY,
  type QualityCheck,
} from "./scan-quality";

/**
 * Plausibility bounds for iris-calibrated measurements (millimeters).
 * Catches the failure mode where MediaPipe returns a high-confidence
 * detection on something that isn't a real face — a poster, a screen
 * reflection, a rendered avatar — and "calibrates" against a non-iris,
 * producing nonsense millimeters that would otherwise feed into the
 * recommender.
 *
 * The window is the UNION of the server's adult and pediatric windows
 * (`UNION_PLAUSIBILITY_BOUNDS` in resupply-api's lib/fitting/
 * confidence.ts), deliberately: this page does not know the patient's
 * population — the CHART does, server-side, from date of birth — and an
 * adult-only window rejected every pediatric face at /measure, making
 * the server's entire pediatric fitting path unreachable from the
 * scanner. Population-correct validation happens on the server; this
 * gate only has to reject non-faces.
 *
 * This is the one copy of the table that cannot import the server's
 * (different workspace, browser bundle). It is kept honest by
 * `face-measurements.accuracy.test.ts`, which holds these numbers to the
 * same canonical-face margin the server's own windows are held to — so a
 * drift here fails CI rather than silently rejecting real patients.
 *
 * CALIBRATION. Anchored to MediaPipe's canonical face model, the metric
 * mesh the landmark indices are defined against: every bound clears that
 * average adult face by ≥25% — ~18% of population spread (±3 SD at
 * SD ≈ 6% of the mean) plus the pipeline's own verified 7% worst-case
 * error. Note `noseHeight` is the bridge→tip span (~29 mm on an average
 * face), NOT the ~50 mm nasion→subnasale "nose height" of the textbooks.
 */
export const PLAUSIBILITY_BOUNDS = {
  noseWidth: [12, 55],
  noseHeight: [15, 45],
  noseToChin: [25, 125],
  mouthWidth: [18, 70],
  faceWidthAtCheekbones: [80, 200],
} as const;

export type PlausibilityField = keyof typeof PLAUSIBILITY_BOUNDS;

/**
 * Returns the first measurement field that's outside its plausibility
 * window, or null if every field is within bounds. Used to reject
 * obviously-bad iris calibrations before they reach the recommender.
 */
export function findImplausibleMeasurement(
  m: FacialMeasurements,
): PlausibilityField | null {
  for (const [key, [min, max]] of Object.entries(PLAUSIBILITY_BOUNDS) as Array<
    [PlausibilityField, readonly [number, number]]
  >) {
    const v = m[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return key;
    }
  }
  return null;
}

/**
 * Predicate for the GuardedMeasure route guard.
 *
 * Returns true if the user is allowed to remain on /measure. The non-
 * obvious case is `capturedImage === null && measurements != null` —
 * that's the brief post-extraction window where /measure has just
 * cleared the image for privacy and is about to navigate to
 * /questionnaire. Bouncing back to /capture in that window strands the
 * user (PR #124).
 *
 * Pull this into the guard rather than re-deriving the rule inline so
 * the invariant is documented and unit-testable.
 */
export function canStayOnMeasure(
  capturedImage: string | null,
  measurements: FacialMeasurements | null,
): boolean {
  return capturedImage != null || measurements != null;
}

/**
 * The static advice for each way extraction can fail.
 *
 * Written from the pipeline's own failure reasons rather than as general
 * photography tips, and kept here (not in the page) so the selection
 * logic below is testable without a camera.
 */
export const FAIL_HINTS: Record<ExtractionFailReason, string[]> = {
  no_face: [
    "Center your face inside the oval guide.",
    "Look directly at the camera — not up, down, or to the side.",
    "Make sure your forehead, eyes, nose, and chin are all in frame.",
  ],
  eyes_unreadable: [
    // The measurement scale comes from the iris, so the eyes are the one
    // part of the face that has to be clearly visible. Glare is the
    // usual culprit and the patient cannot see it happening.
    "Take off glasses — even clear lenses catch glare that hides your eyes.",
    "Face a window or a lamp rather than having one behind you.",
    "Sweep hair away from your eyes and look straight at the camera.",
  ],
  iris_too_small: [
    "Hold the camera closer — about an arm's length from your face.",
    // NOT "use the front camera": this app hard-codes `facingMode:
    // "user"` on both capture pages and offers no camera picker, so the
    // old bullet sent patients hunting for a control that doesn't exist.
    "Hold the phone steady at eye level so your whole face fills the oval.",
    "Take off glasses, sunglasses, or anything covering your eyes.",
  ],
  implausible_measurements: [
    "Make sure it's a real face in the frame, not a photo or screen.",
    "Take off glasses and remove anything covering parts of your face.",
    "Even, front-on lighting works best — avoid strong side or back light.",
  ],
  image_decode: [
    "Try retaking the photo — the captured frame couldn't be decoded.",
  ],
  image_decode_timeout: [
    "The captured photo took too long to load. Try again, ideally on Wi-Fi or after closing other camera-using apps.",
  ],
  model_load_timeout: [
    "The measurement model took too long to download. Check your connection — Wi-Fi helps — and try again.",
    "If this keeps happening, you can browse the mask catalog or ask our team for help instead.",
  ],
  unknown: [
    "Try retaking the photo with even lighting and your face centered.",
  ],
};

/**
 * How many failed attempts before the page stops offering only "try
 * again" and starts offering a person.
 *
 * Two: the first failure is bad luck and the advice is worth following,
 * the second says something about this patient's device, lighting or
 * face that another identical attempt will not fix. Left any higher and
 * the patient concludes the product is broken before we concede it.
 */
export const SCAN_ESCALATE_AFTER = 2;

/** The subset of a scored frame this module needs. */
export interface HintFrameQuality {
  scores: Record<string, number>;
  distanceHint?: "closer" | "farther" | null;
}

/**
 * The advice to show for a failed extraction.
 *
 * WHY THIS ISN'T JUST A LOOKUP. Every frame that reached the extractor
 * was already scored on six checks — lighting, distance, pose,
 * occlusion, motion, framing — and on failure those scores were thrown
 * away. So a capture that failed with `lighting` at 0.2 was answered
 * with "Center your face inside the oval guide", while the codebase
 * already contained the line that would have helped ("Find more even
 * light…") and had already measured that it applied. The guided flow
 * says exactly that sentence, live, to the patients lucky enough to be
 * on a tenant that enabled it.
 *
 * So: when the frames carry quality, the worst failing check's own coach
 * line goes FIRST, and the static bullets follow as the fallback they
 * always were. The coach copy is imported, not re-typed — one voice, one
 * place to fix it.
 *
 * `escalate` is separate from the copy on purpose: what to say after two
 * failures is a page-level decision (it offers a human), not another
 * bullet.
 */
export function failureHints(
  reason: ExtractionFailReason,
  frames: ReadonlyArray<{ quality: HintFrameQuality }> | null,
  attempt: number,
): { bullets: string[]; escalate: boolean } {
  const base = FAIL_HINTS[reason] ?? FAIL_HINTS.unknown;
  const escalate = attempt >= SCAN_ESCALATE_AFTER;
  if (!frames || frames.length === 0) return { bullets: [...base], escalate };

  // Mean per check across the frames that were scored, so one bad frame
  // in a burst doesn't pick the advice for the other four.
  const checks = Object.keys(COACH_COPY) as QualityCheck[];
  let worst: QualityCheck | null = null;
  let worstScore = Number.POSITIVE_INFINITY;
  for (const check of checks) {
    const scored = frames
      .map((f) => f.quality.scores[check])
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
    if (scored.length === 0) continue;
    const mean = scored.reduce((a, b) => a + b, 0) / scored.length;
    if (mean < worstScore) {
      worstScore = mean;
      worst = check;
    }
  }

  // Only when the check genuinely failed. A capture can fail extraction
  // with every quality score healthy — a poster, a screen — and inventing
  // a "your lighting was poor" line for it would send the patient to fix
  // something that was fine.
  if (!worst || worstScore >= 0.6) return { bullets: [...base], escalate };

  let lead = COACH_COPY[worst];
  if (worst === "distance") {
    // The direction is already known per frame; a bare "arm's length"
    // when we can say "a little closer" wastes what was measured.
    const hints = frames
      .map((f) => f.quality.distanceHint)
      .filter(
        (h): h is "closer" | "farther" => h === "closer" || h === "farther",
      );
    const closer = hints.filter((h) => h === "closer").length;
    const farther = hints.length - closer;
    if (closer > farther) lead = DISTANCE_COACH_COPY.closer;
    else if (farther > closer) lead = DISTANCE_COACH_COPY.farther;
  }

  // Deduped: several static bullets say the same thing as a coach line
  // in different words, and repeating it reads as padding.
  const bullets = [lead, ...base.filter((b) => b !== lead)];
  return { bullets, escalate };
}
