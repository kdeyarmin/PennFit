// Mask-fit feedback → recommendation-engine tuning (RT #22b).
//
// Closes the loop the rec engine flies blind on: turn accumulated
// post-fit outcomes (#22a `mask_fit_outcomes`: good / leaking /
// uncomfortable per mask) into a small per-mask RANKING multiplier the
// engine can apply (`recommend({ fitAdjustments })`). Pure — no I/O,
// unit-tested. The route/job sources the counts; this is just the math.
//
// Design guardrails:
//   * Neutral until proven — a mask needs `minSamples` real outcomes
//     before it earns any adjustment (default 10). Below that → 1.0.
//   * Bounded — the multiplier is clamped to ±`maxAdjustment` (default
//     0.15) so feedback can re-order near-ties but can never rescue a
//     clinically poor mask or bury a good one. Mirrors the intent of the
//     manufacturer boost.
//   * Monotonic — higher good-rate ⇒ higher multiplier.

export interface MaskOutcomeCounts {
  good: number;
  leaking: number;
  uncomfortable: number;
}

export interface TuningOptions {
  /** Minimum outcomes before a mask earns a non-neutral multiplier. */
  minSamples?: number;
  /** Max absolute deviation from 1.0 (e.g. 0.15 → [0.85, 1.15]). */
  maxAdjustment?: number;
}

/**
 * Pure: map per-mask outcome counts to per-mask ranking multipliers
 * centered on 1.0. A "seal score" of (good − bad) / total in [-1, 1] is
 * scaled by maxAdjustment; masks below minSamples are omitted (caller
 * treats a missing key as neutral 1.0).
 */
export function computeFitAdjustments(
  byMask: Record<string, MaskOutcomeCounts>,
  opts: TuningOptions = {},
): Record<string, number> {
  const minSamples = opts.minSamples ?? 10;
  const maxAdjustment = opts.maxAdjustment ?? 0.15;

  const out: Record<string, number> = {};
  for (const [maskId, c] of Object.entries(byMask)) {
    const good = Math.max(0, c.good);
    const leaking = Math.max(0, c.leaking);
    const uncomfortable = Math.max(0, c.uncomfortable);
    const total = good + leaking + uncomfortable;
    if (total < minSamples) continue; // not enough signal → neutral

    // Seal score in [-1, 1]: all-good → +1, all-bad → -1.
    const sealScore = (good - (leaking + uncomfortable)) / total;
    const multiplier = 1 + sealScore * maxAdjustment;
    // Clamp defensively (sealScore is already bounded, but be safe).
    out[maskId] = Math.min(
      1 + maxAdjustment,
      Math.max(1 - maxAdjustment, Number(multiplier.toFixed(4))),
    );
  }
  return out;
}

/**
 * Pure: fold a flat list of (maskId, outcome) rows into per-mask counts.
 * Rows with a null/empty maskId are dropped (can't attribute). Lets the
 * route hand raw outcome rows straight to computeFitAdjustments.
 */
export function tallyOutcomesByMask(
  rows: ReadonlyArray<{
    maskId: string | null;
    fitOutcome: "good" | "leaking" | "uncomfortable";
  }>,
): Record<string, MaskOutcomeCounts> {
  const byMask: Record<string, MaskOutcomeCounts> = {};
  for (const r of rows) {
    if (!r.maskId) continue;
    const c = (byMask[r.maskId] ??= {
      good: 0,
      leaking: 0,
      uncomfortable: 0,
    });
    c[r.fitOutcome] += 1;
  }
  return byMask;
}
