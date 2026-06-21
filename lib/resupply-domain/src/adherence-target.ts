// Progressive adherence target — pure clinical scoring (ADR 008: no I/O).
//
// The compliance scanner grades a patient's adherence against a target
// that RAMPS UP over the first 90 days of therapy: a new patient isn't
// expected to hit the full Medicare 70%-of-nights bar on day 8, but they
// should be climbing toward it, and a patient still well short at day 90
// is the irrecoverable case CMS uses to deny coverage. This is the pure
// decision behind the scanner's "on_track / warning / critical" CSR
// alerts (sibling to metric-threshold / goal-pace).
//
// The final band is anchored to the CMS rule, not a magic number: its
// target IS `COMPLIANCE_NIGHT_RATIO` (0.7) and its boundary IS the
// attestation horizon (`ATTESTATION_HORIZON_DAYS`, 90 days), both imported
// from cms-adherence so the scanner and the attestation can't drift. The
// earlier bands (0.5 → 0.6 → 0.65) are the ramp toward that bar.

import {
  ATTESTATION_HORIZON_DAYS,
  COMPLIANCE_NIGHT_RATIO,
} from "./cms-adherence";

export type AdherenceLevel = "on_track" | "warning" | "critical";

export interface AdherenceTargetScore {
  level: AdherenceLevel;
  /** The adherence ratio (0..1) the patient is expected to hit by now. */
  target: number;
}

// Ramp band boundaries (days on therapy) and their targets.
const BAND_2_DAY = 30;
const BAND_3_DAY = 60;
const TARGET_BAND_1 = 0.5; // day 7-29
const TARGET_BAND_2 = 0.6; // day 30-59
const TARGET_BAND_3 = 0.65; // day 60-89
const CRITICAL_BAND_2 = 0.4;
const CRITICAL_BAND_3 = 0.45;

/**
 * Grade `adherence` (0..1, the share of compliant nights so far) against
 * the day-banded target. Pure + total.
 *
 *   * day < 7        → on_track (too early to call it; target 0)
 *   * day 7-29       → target 0.5; below → warning
 *   * day 30-59      → target 0.6; below 0.4 → critical, else warning
 *   * day 60-89      → target 0.65; below 0.45 → critical, else warning
 *   * day >= 90      → target = CMS ratio (0.7); below → critical
 */
export function scoreAdherenceTarget(
  elapsedDays: number,
  adherence: number,
): AdherenceTargetScore {
  if (elapsedDays < 7) return { level: "on_track", target: 0 };

  if (elapsedDays < BAND_2_DAY) {
    const target = TARGET_BAND_1;
    return adherence >= target
      ? { level: "on_track", target }
      : { level: "warning", target };
  }

  if (elapsedDays < BAND_3_DAY) {
    const target = TARGET_BAND_2;
    if (adherence >= target) return { level: "on_track", target };
    if (adherence < CRITICAL_BAND_2) return { level: "critical", target };
    return { level: "warning", target };
  }

  if (elapsedDays < ATTESTATION_HORIZON_DAYS) {
    const target = TARGET_BAND_3;
    if (adherence >= target) return { level: "on_track", target };
    if (adherence < CRITICAL_BAND_3) return { level: "critical", target };
    return { level: "warning", target };
  }

  // 90+ days: failing here is the irrecoverable case CMS uses to deny
  // adherence. The bar is the CMS qualifying ratio itself.
  const target = COMPLIANCE_NIGHT_RATIO;
  return adherence >= target
    ? { level: "on_track", target }
    : { level: "critical", target };
}
