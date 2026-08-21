/**
 * Pure helpers for the /measure → /questionnaire flow. Lives in its own
 * file so we can unit-test the routing invariant and the measurement
 * plausibility window without dragging in MediaPipe / camera / DOM.
 */
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";

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
