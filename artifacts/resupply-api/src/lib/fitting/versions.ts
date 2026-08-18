/**
 * Version stamps for the clinical fitting engine.
 *
 * Both constants are stamped onto every `fit_sessions` row at compute time
 * and printed on every fit report. They are NEVER recomputed on read, so a
 * report reprinted a year from now names the rules that actually ran rather
 * than today's.
 *
 * Bump RULES_ENGINE_VERSION whenever the tier logic, the scoring weights,
 * the confidence thresholds, or the exception-state boundaries change —
 * anything that could make the engine return a different answer for the
 * same patient. Adding a field to the output shape does not require a bump;
 * changing what the engine decides does.
 */

/** The tiered recommendation pipeline. */
export const RULES_ENGINE_VERSION = "fit-rules@2026.08.1";

/** The Patient Fit Profile question set. */
export const FIT_PROFILE_VERSION = "fit_profile_v2";

/** The legacy 11-question set, still accepted on the original endpoint. */
export const LEGACY_PROFILE_VERSION = "fit_profile_v1";
