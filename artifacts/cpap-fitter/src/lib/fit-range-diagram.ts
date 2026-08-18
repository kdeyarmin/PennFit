// Geometry for the to-scale fit diagram on the results page.
//
// WHY A DIAGRAM AT ALL
// --------------------
// The results page tells a patient which mask and size to try, and asks
// them to believe it. A picture of the mask rendered onto a model of
// their face would look more convincing — and would be overclaiming: the
// engine reasons over a handful of scalar millimetre measurements, not a
// mesh, and re-opening the camera after the patient has dismissed it is
// a UX and consent regression for a decoration.
//
// What IS honest, and more useful, is showing the actual comparison the
// engine made: this mask fits noses from X to Y mm, yours is Z. That
// explains the recommendation instead of merely asserting it, is exactly
// as precise as the underlying data, and needs no camera, no upload, and
// no new endpoint — the measurements are already in the browser and the
// ranges already ride along with the mask.
//
// PHI: nothing here leaves the device. This module is pure arithmetic on
// numbers the browser already holds.

export interface FitRangeRow {
  /** Human label, e.g. "Nose width". */
  label: string;
  /** Patient's own measurement, in mm. */
  value: number;
  /** The mask's fit range for this dimension, in mm. */
  min: number;
  /** The mask's fit range for this dimension, in mm. */
  max: number;
}

export interface FitRangeGeometry extends FitRangeRow {
  /** Left edge of the mask's band, 0..100 (% of the track). */
  bandStartPct: number;
  /** Width of the mask's band, 0..100 (% of the track). */
  bandWidthPct: number;
  /** Where the patient's measurement sits, 0..100 (% of the track). */
  markerPct: number;
  /** Whether the measurement falls inside the mask's range. */
  inRange: boolean;
}

/**
 * Pick a display domain that always shows BOTH the mask's band and the
 * patient's measurement, with breathing room at each end.
 *
 * The padding is deliberately proportional to the band, not fixed: it
 * keeps a wide range from looking cramped and, more importantly, keeps a
 * measurement that sits just outside the band from being pinned to the
 * very edge of the track where it reads as "on the line" rather than
 * "outside".
 */
function domainFor(row: FitRangeRow): { lo: number; hi: number } {
  const lo = Math.min(row.min, row.value);
  const hi = Math.max(row.max, row.value);
  const span = hi - lo;
  // A zero span (single-point range, measurement exactly on it) would
  // divide by zero below; give it an arbitrary but sane window.
  const pad = span > 0 ? span * 0.15 : 5;
  return { lo: lo - pad, hi: hi + pad };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

/**
 * Turn one dimension's (measurement, range) pair into track geometry.
 *
 * Returns null when the inputs can't produce an honest picture — a
 * non-finite number, or an inverted range. Callers skip the row rather
 * than drawing something misleading.
 */
export function buildFitRangeGeometry(
  row: FitRangeRow,
): FitRangeGeometry | null {
  if (
    !Number.isFinite(row.value) ||
    !Number.isFinite(row.min) ||
    !Number.isFinite(row.max) ||
    row.max < row.min
  ) {
    return null;
  }

  const { lo, hi } = domainFor(row);
  const span = hi - lo;
  if (!(span > 0)) return null;

  const pctOf = (n: number) => clampPct(((n - lo) / span) * 100);
  const bandStartPct = pctOf(row.min);
  const bandEndPct = pctOf(row.max);

  return {
    ...row,
    bandStartPct,
    bandWidthPct: Math.max(0, bandEndPct - bandStartPct),
    markerPct: pctOf(row.value),
    // Inclusive: a measurement exactly on the boundary is a fit. The
    // published ranges are themselves rounded, so treating the endpoint
    // as a miss would invent a precision the data doesn't have.
    inRange: row.value >= row.min && row.value <= row.max,
  };
}

/** Round for display without implying more precision than we have. */
export function mm(n: number): string {
  return `${Math.round(n)} mm`;
}
