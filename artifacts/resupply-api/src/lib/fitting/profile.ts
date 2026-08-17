/**
 * Patient Fit Profile construction and back-compatibility — pure.
 *
 * The original fitter asked 11 questions. The Fit Profile asks around 20,
 * across six short chapters. Both must work: an in-flight patient session,
 * the existing `/api/recommend` endpoint, and the chatbot all still speak
 * the 11-answer shape.
 *
 * So `QuestionnaireAnswers` (v1) is treated as a strict subset of
 * `FitProfile` (v2), and `fromLegacyAnswers()` widens one into the other
 * without inventing anything: a field the old questionnaire never asked
 * stays `null`, which every branch in the engine reads as "not known"
 * rather than "no".
 */

import { FIT_PROFILE_VERSION, LEGACY_PROFILE_VERSION } from "./versions.js";
import type { FitProfile, LeakLocation, SleepPosition } from "./types.js";

/** The original 11 answers, unchanged. */
export interface LegacyQuestionnaireAnswers {
  mouthBreather: boolean | null;
  claustrophobic: boolean | null;
  sideOrStomachSleeper: boolean | null;
  heavyFacialHair: boolean | null;
  wearsGlasses: boolean | null;
  frequentCongestion: boolean | null;
  priorMaskExperience: "none" | "nasal" | "nasalPillow" | "fullFace" | "hybrid";
  mobilityLimitations: boolean | null;
  sensitiveSkin: boolean | null;
  siliconeSensitivity: boolean | null;
  cpapPressureSetting: "unknown" | "low" | "medium" | "high";
}

/** A profile with every optional field explicitly unknown. */
export function emptyProfile(): FitProfile {
  return {
    version: FIT_PROFILE_VERSION,
    population: "adult",
    therapyMode: "pap",
    therapyDevice: "unknown",
    pressureCmH2O: null,
    pressureBand: "unknown",
    supplementalOxygen: null,
    mouthBreather: null,
    nasalObstruction: null,
    frequentCongestion: null,
    dryMouth: null,
    sleepPositions: [],
    claustrophobia: null,
    minimalContactPreference: null,
    facialHair: null,
    dentures: null,
    facialStructureChange: null,
    skinIrritation: null,
    sensitiveSkin: null,
    siliconeSensitivity: null,
    wearsGlasses: null,
    priorMaskExperience: "none",
    priorMaskModelSlug: null,
    priorMaskSize: null,
    priorLeakLocations: [],
    priorMaskSatisfaction: null,
    headgearDifficulty: null,
    handDexterity: null,
    visionOrCognitiveLimitation: null,
  };
}

/**
 * Widen the 11 legacy answers into a full profile.
 *
 * Note what is deliberately NOT inferred: `sideOrStomachSleeper === false`
 * becomes an empty position list rather than `["back"]`, because "not
 * primarily a side sleeper" is not the same claim as "sleeps on their
 * back". Guessing here would silently change recommendations for every
 * patient who came through the old questionnaire.
 */
export function fromLegacyAnswers(
  answers: Partial<LegacyQuestionnaireAnswers>,
): FitProfile {
  const profile = emptyProfile();
  profile.version = LEGACY_PROFILE_VERSION;

  profile.mouthBreather = answers.mouthBreather ?? null;
  profile.frequentCongestion = answers.frequentCongestion ?? null;
  if (answers.frequentCongestion === true) {
    profile.nasalObstruction = "seasonal";
  } else if (answers.frequentCongestion === false) {
    profile.nasalObstruction = "none";
  }

  if (answers.claustrophobic === true) profile.claustrophobia = "severe";
  else if (answers.claustrophobic === false) profile.claustrophobia = "none";

  const positions: SleepPosition[] = [];
  if (answers.sideOrStomachSleeper === true) positions.push("side");
  profile.sleepPositions = positions;

  if (answers.heavyFacialHair === true) profile.facialHair = "full_beard";
  else if (answers.heavyFacialHair === false) profile.facialHair = "none";

  profile.wearsGlasses = answers.wearsGlasses ?? null;
  profile.sensitiveSkin = answers.sensitiveSkin ?? null;
  profile.siliconeSensitivity = answers.siliconeSensitivity ?? null;
  if (answers.sensitiveSkin === true) profile.skinIrritation = "irritation";
  else if (answers.sensitiveSkin === false) profile.skinIrritation = "none";

  profile.priorMaskExperience = answers.priorMaskExperience ?? "none";

  if (answers.mobilityLimitations === true) profile.handDexterity = "limited";
  else if (answers.mobilityLimitations === false)
    profile.handDexterity = "normal";

  profile.pressureBand = answers.cpapPressureSetting ?? "unknown";
  return profile;
}

/**
 * Merge a partial v2 profile over the legacy answers.
 *
 * The v2 blocks are optional on the wire, so a client that has been
 * updated sends both and a client that hasn't sends only the 11. Anything
 * the v2 block states wins; anything it omits keeps whatever the legacy
 * mapping produced.
 */
export function buildProfile(
  legacy: Partial<LegacyQuestionnaireAnswers> | null,
  v2: Partial<FitProfile> | null,
): FitProfile {
  const base = legacy ? fromLegacyAnswers(legacy) : emptyProfile();
  if (!v2) return base;

  const merged: FitProfile = { ...base };
  for (const [key, value] of Object.entries(v2)) {
    if (value === undefined) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  // A profile carrying any v2 field is a v2 profile, and must be stamped
  // as one so the fit report cites the right question set.
  merged.version = v2.version ?? FIT_PROFILE_VERSION;

  // Derive the coarse band from an exact pressure when we have one, so
  // downstream code that only understands the band still works.
  if (v2.pressureCmH2O !== undefined && v2.pressureCmH2O !== null) {
    merged.pressureBand =
      v2.pressureCmH2O >= 15
        ? "high"
        : v2.pressureCmH2O >= 10
          ? "medium"
          : "low";
  }
  return merged;
}

const LEAK_LOCATIONS: readonly LeakLocation[] = [
  "bridge_of_nose",
  "cheeks",
  "sides",
  "mouth",
  "chin",
];

export function isLeakLocation(value: unknown): value is LeakLocation {
  return (
    typeof value === "string" &&
    (LEAK_LOCATIONS as readonly string[]).includes(value)
  );
}

const SLEEP_POSITIONS: readonly SleepPosition[] = [
  "back",
  "side",
  "stomach",
  "mixed",
];

export function isSleepPosition(value: unknown): value is SleepPosition {
  return (
    typeof value === "string" &&
    (SLEEP_POSITIONS as readonly string[]).includes(value)
  );
}
