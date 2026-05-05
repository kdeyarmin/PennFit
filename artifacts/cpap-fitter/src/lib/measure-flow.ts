/**
 * Pure helpers for the /measure → /questionnaire flow. Lives in its own
 * file so we can unit-test the routing invariant and the measurement
 * plausibility window without dragging in MediaPipe / camera / DOM.
 */
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";

/**
 * Plausibility bounds for iris-calibrated measurements (millimeters).
 * Generous enough to cover ~99% of adult faces per anthropometric
 * surveys, narrow enough to catch the failure mode where MediaPipe
 * returns a high-confidence detection on something that isn't a real
 * face — a poster, a screen reflection, a rendered avatar — and
 * "calibrates" against a non-iris, producing nonsense millimeters that
 * would otherwise feed into the recommender.
 */
export const PLAUSIBILITY_BOUNDS = {
  noseWidth: [20, 60],
  noseHeight: [25, 70],
  noseToChin: [40, 90],
  mouthWidth: [30, 80],
  faceWidthAtCheekbones: [110, 180],
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
