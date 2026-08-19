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
 * (PLAUSIBILITY_BOUNDS / PEDIATRIC_PLAUSIBILITY_BOUNDS in
 * lib/fitting/confidence.ts), deliberately: this page does not know the
 * patient's population — the CHART does, server-side, from date of birth
 * — and the previous adult-only window rejected every pediatric face at
 * /measure, making the server's entire pediatric fitting path
 * unreachable from the scanner. Population-correct validation happens on
 * the server; this gate only has to reject non-faces.
 */
export const PLAUSIBILITY_BOUNDS = {
  noseWidth: [12, 60],
  noseHeight: [15, 70],
  noseToChin: [25, 90],
  mouthWidth: [18, 80],
  faceWidthAtCheekbones: [80, 180],
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
