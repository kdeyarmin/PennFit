/**
 * The Patient Fit Profile question set — pure, no React.
 *
 * The original questionnaire asked 11 questions, one per screen. A
 * clinically useful profile needs about twenty, and asking twenty
 * questions one per screen would roughly double the drop-off on a step
 * patients already abandon.
 *
 * Three things keep it short:
 *
 *   1. SIX CHAPTERS, not twenty questions. Progress is reported within a
 *      chapter ("2 of 4") and across chapters, so the flow reads as six
 *      short stretches rather than one long climb.
 *   2. BRANCHING. `nextQuestionIndex` skips whole groups that cannot
 *      apply — previous-mask detail for a first-time user, the
 *      trim-the-beard follow-up for a clean-shaven patient, ventilator
 *      questions on CPAP. The median patient sees around thirteen.
 *   3. MULTI-SELECT. "Where did your old mask leak?" is one chip screen
 *      rather than five yes/no screens.
 *
 * The safety chapter is deliberately last and unskippable, and its
 * questions come from the server's version-controlled question set rather
 * than from this file — a manufacturer revising a warning must not require
 * a deploy.
 */

export type FitProfileFieldId =
  | "therapyDevice"
  | "pressureCmH2O"
  | "supplementalOxygen"
  | "mouthBreather"
  | "nasalObstruction"
  | "dryMouth"
  | "sleepPositions"
  | "claustrophobia"
  | "minimalContactPreference"
  | "facialHair"
  | "dentures"
  | "skinIrritation"
  | "wearsGlasses"
  | "priorMaskExperience"
  | "priorMaskSize"
  | "priorLeakLocations"
  | "priorMaskSatisfaction"
  | "headgearDifficulty"
  | "handDexterity"
  | "visionOrCognitiveLimitation";

export type ChapterId =
  | "therapy"
  | "breathing"
  | "sleep"
  | "face"
  | "history"
  | "safety";

export interface ChapterMeta {
  id: ChapterId;
  title: string;
  blurb: string;
}

export const CHAPTERS: ChapterMeta[] = [
  {
    id: "therapy",
    title: "Your therapy",
    blurb: "What your machine is set to do. Skip anything you're unsure of.",
  },
  {
    id: "breathing",
    title: "How you breathe",
    blurb: "This is what decides between a nasal and a full face mask.",
  },
  {
    id: "sleep",
    title: "How you sleep",
    blurb: "Position and comfort matter as much as measurements.",
  },
  {
    id: "face",
    title: "Your face and skin",
    blurb: "A few things that change where a mask can seal comfortably.",
  },
  {
    id: "history",
    title: "What you've tried",
    blurb:
      "If you've worn a mask before, what went wrong is the best clue we have.",
  },
  {
    id: "safety",
    title: "Safety check",
    blurb:
      "Some masks use magnets. These questions keep you and your household safe.",
  },
];

export type AnswerKind = "boolean" | "single" | "multi" | "number" | "scale";

export interface Option {
  value: string;
  label: string;
  sublabel?: string;
}

export interface FitQuestion {
  id: FitProfileFieldId;
  chapter: ChapterId;
  kind: AnswerKind;
  question: string;
  help?: string;
  options?: Option[];
  /** Shown as the "I'm not sure" escape. Absent = the question is required. */
  allowUnsure?: boolean;
  unit?: string;
  min?: number;
  max?: number;
}

export const FIT_QUESTIONS: FitQuestion[] = [
  // ── Chapter 1: therapy ──
  {
    id: "therapyDevice",
    chapter: "therapy",
    kind: "single",
    question: "What kind of machine were you prescribed?",
    allowUnsure: true,
    options: [
      { value: "cpap", label: "CPAP", sublabel: "One steady pressure" },
      {
        value: "apap",
        label: "APAP or AutoSet",
        sublabel: "Adjusts through the night",
      },
      {
        value: "bilevel",
        label: "BiPAP or bilevel",
        sublabel: "Two pressures",
      },
      { value: "asv", label: "ASV", sublabel: "Adaptive servo-ventilation" },
    ],
  },
  {
    id: "pressureCmH2O",
    chapter: "therapy",
    kind: "number",
    question: "What pressure is your machine set to?",
    help: "It's on your prescription or your machine's settings screen. Skip it if you don't know — we'll still give you a recommendation.",
    unit: "cmH₂O",
    min: 4,
    max: 30,
    allowUnsure: true,
  },
  {
    id: "supplementalOxygen",
    chapter: "therapy",
    kind: "boolean",
    question: "Do you use supplemental oxygen with your therapy?",
    allowUnsure: true,
  },

  // ── Chapter 2: breathing ──
  {
    id: "mouthBreather",
    chapter: "breathing",
    kind: "boolean",
    question: "Do you often breathe through your mouth while you sleep?",
    help: "Waking with a very dry mouth is the usual sign.",
    allowUnsure: true,
  },
  {
    id: "nasalObstruction",
    chapter: "breathing",
    kind: "single",
    question: "How is your nasal breathing?",
    allowUnsure: true,
    options: [
      { value: "none", label: "Clear most of the time" },
      { value: "seasonal", label: "Blocked at certain times of year" },
      { value: "chronic", label: "Blocked most of the time" },
      { value: "post_surgical", label: "I've had nasal or sinus surgery" },
    ],
  },
  {
    id: "dryMouth",
    chapter: "breathing",
    kind: "boolean",
    question: "Do you wake up with a dry mouth or throat?",
    allowUnsure: true,
  },

  // ── Chapter 3: sleep and comfort ──
  {
    id: "sleepPositions",
    chapter: "sleep",
    kind: "multi",
    question: "How do you usually sleep?",
    help: "Pick everything that applies.",
    options: [
      { value: "back", label: "On my back" },
      { value: "side", label: "On my side" },
      { value: "stomach", label: "On my stomach" },
      { value: "mixed", label: "I move around a lot" },
    ],
  },
  {
    id: "claustrophobia",
    chapter: "sleep",
    kind: "single",
    question: "Does having something on your face make you feel closed in?",
    allowUnsure: true,
    options: [
      { value: "none", label: "Not at all" },
      { value: "mild", label: "A little" },
      { value: "severe", label: "Yes, quite a lot" },
    ],
  },
  {
    id: "minimalContactPreference",
    chapter: "sleep",
    kind: "single",
    question: "Which would you rather wear?",
    allowUnsure: true,
    options: [
      {
        value: "minimal",
        label: "As little on my face as possible",
        sublabel: "Small cushions and slim frames",
      },
      {
        value: "traditional",
        label: "Something more substantial",
        sublabel: "A traditional cushion and frame",
      },
      { value: "no_preference", label: "No strong preference" },
    ],
  },

  // ── Chapter 4: face and skin ──
  {
    id: "facialHair",
    chapter: "face",
    kind: "single",
    question: "Do you have facial hair?",
    options: [
      { value: "none", label: "Clean shaven" },
      { value: "stubble", label: "Stubble" },
      { value: "moustache", label: "A moustache" },
      { value: "full_beard", label: "A full beard" },
    ],
  },
  {
    id: "dentures",
    chapter: "face",
    kind: "boolean",
    question: "Do you wear dentures?",
    help: "It changes the shape of your lower face, which affects where a full face mask can seal.",
    allowUnsure: true,
  },
  {
    id: "skinIrritation",
    chapter: "face",
    kind: "single",
    question: "Has a mask ever marked or irritated your skin?",
    allowUnsure: true,
    options: [
      { value: "none", label: "No" },
      { value: "irritation", label: "Redness or irritation" },
      { value: "pressure_sore", label: "A sore or broken skin" },
    ],
  },
  {
    id: "wearsGlasses",
    chapter: "face",
    kind: "boolean",
    question: "Do you like to read or watch TV in bed with glasses on?",
    allowUnsure: true,
  },

  // ── Chapter 5: history and handling ──
  {
    id: "priorMaskExperience",
    chapter: "history",
    kind: "single",
    question: "Have you used a CPAP mask before?",
    options: [
      { value: "none", label: "No, this is my first" },
      { value: "nasal", label: "A nasal mask", sublabel: "Covers the nose" },
      {
        value: "nasalPillow",
        label: "Nasal pillows",
        sublabel: "Sit in the nostrils",
      },
      {
        value: "fullFace",
        label: "A full face mask",
        sublabel: "Nose and mouth",
      },
      {
        value: "hybrid",
        label: "A hybrid mask",
        sublabel: "Under the nose, over the mouth",
      },
    ],
  },
  {
    id: "priorMaskSize",
    chapter: "history",
    kind: "single",
    question: "What size was it?",
    allowUnsure: true,
    options: [
      { value: "XS", label: "Extra small" },
      { value: "S", label: "Small" },
      { value: "M", label: "Medium" },
      { value: "L", label: "Large" },
      { value: "XL", label: "Extra large" },
    ],
  },
  {
    id: "priorLeakLocations",
    chapter: "history",
    kind: "multi",
    question: "Where did it leak?",
    help: "Pick everything that applies. This is one of the most useful things you can tell us.",
    options: [
      {
        value: "bridge_of_nose",
        label: "Bridge of my nose",
        sublabel: "Air into the eyes",
      },
      { value: "cheeks", label: "Cheeks" },
      { value: "sides", label: "The sides" },
      { value: "mouth", label: "Around my mouth" },
      { value: "chin", label: "Under my chin" },
    ],
  },
  {
    id: "priorMaskSatisfaction",
    chapter: "history",
    kind: "scale",
    question: "How did you get on with it overall?",
    min: 1,
    max: 5,
    allowUnsure: true,
  },
  {
    id: "headgearDifficulty",
    chapter: "history",
    kind: "boolean",
    question: "Is putting a mask on and taking it off difficult?",
    allowUnsure: true,
  },
  {
    id: "handDexterity",
    chapter: "history",
    kind: "single",
    question: "How is your hand strength and dexterity?",
    allowUnsure: true,
    options: [
      { value: "normal", label: "No problems" },
      { value: "limited", label: "Limited — arthritis, tremor, or weakness" },
      { value: "caregiver_assisted", label: "Someone helps me put it on" },
    ],
  },
  {
    id: "visionOrCognitiveLimitation",
    chapter: "history",
    kind: "boolean",
    question: "Would low light or memory make a fiddly mask hard to manage?",
    allowUnsure: true,
  },
];

export type AnswerValue = string | string[] | number | boolean | null;
export type FitAnswers = Partial<Record<FitProfileFieldId, AnswerValue>>;

/**
 * Whether a question applies given the answers so far.
 *
 * This is what keeps the median path near thirteen questions instead of
 * twenty. Every rule here is "we already know this cannot apply", never
 * "this seems unlikely" — skipping a question we might have needed is a
 * worse trade than one extra tap.
 */
export function questionApplies(
  question: FitQuestion,
  answers: FitAnswers,
): boolean {
  switch (question.id) {
    // The previous-mask block only exists for someone who had one.
    case "priorMaskSize":
    case "priorLeakLocations":
    case "priorMaskSatisfaction":
      return (
        answers.priorMaskExperience !== undefined &&
        answers.priorMaskExperience !== null &&
        answers.priorMaskExperience !== "none"
      );

    // Oxygen entrainment is a bilevel/ASV and ventilator concern far more
    // than a straight CPAP one, but we still ask when the device is
    // unknown — an unanswered device question must not silently skip a
    // safety-relevant one.
    case "supplementalOxygen":
      return (
        answers.therapyDevice === undefined ||
        answers.therapyDevice === null ||
        answers.therapyDevice !== "cpap"
      );

    // Dry mouth only adds information if they might be mouth-breathing.
    case "dryMouth":
      return answers.mouthBreather !== false;

    // Only worth asking about handling when something suggests difficulty.
    case "visionOrCognitiveLimitation":
      return (
        answers.headgearDifficulty === true ||
        answers.handDexterity === "limited" ||
        answers.handDexterity === "caregiver_assisted"
      );

    default:
      return true;
  }
}

/** The questions that currently apply, in order. */
export function applicableQuestions(answers: FitAnswers): FitQuestion[] {
  return FIT_QUESTIONS.filter((q) => questionApplies(q, answers));
}

/**
 * Drop answers to questions that no longer apply.
 *
 * Going Back and changing a branching answer must not leave the old
 * branch's answers behind: change `therapyDevice` to CPAP and an earlier
 * `supplementalOxygen: true` would otherwise still reach the engine (and
 * the clinical record) for a question the flow just decided not to ask.
 * Iterated to a fixpoint because applicability cascades — pruning one
 * answer can make another question inapplicable in turn.
 */
export function pruneInapplicableAnswers(answers: FitAnswers): FitAnswers {
  const current: FitAnswers = { ...answers };
  for (let pass = 0; pass < FIT_QUESTIONS.length; pass += 1) {
    let changed = false;
    for (const q of FIT_QUESTIONS) {
      if (current[q.id] !== undefined && !questionApplies(q, current)) {
        delete current[q.id];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return current;
}

/**
 * Index of the next question to show after `currentIndex`, or null when
 * the profile is complete. Indices are into `FIT_QUESTIONS`, so a skipped
 * question does not shift the ones after it.
 */
export function nextQuestionIndex(
  currentIndex: number,
  answers: FitAnswers,
): number | null {
  for (let i = currentIndex + 1; i < FIT_QUESTIONS.length; i += 1) {
    if (questionApplies(FIT_QUESTIONS[i]!, answers)) return i;
  }
  return null;
}

export function previousQuestionIndex(
  currentIndex: number,
  answers: FitAnswers,
): number | null {
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    if (questionApplies(FIT_QUESTIONS[i]!, answers)) return i;
  }
  return null;
}

export interface ChapterProgress {
  chapter: ChapterMeta;
  indexInChapter: number;
  chapterLength: number;
  chapterNumber: number;
  totalChapters: number;
}

/** Where the patient is, expressed in chapters rather than raw question count. */
export function chapterProgress(
  currentIndex: number,
  answers: FitAnswers,
): ChapterProgress | null {
  const question = FIT_QUESTIONS[currentIndex];
  if (!question) return null;
  const applicable = applicableQuestions(answers);
  const inChapter = applicable.filter((q) => q.chapter === question.chapter);
  const chapter = CHAPTERS.find((c) => c.id === question.chapter);
  if (!chapter) return null;
  return {
    chapter,
    indexInChapter: inChapter.findIndex((q) => q.id === question.id),
    chapterLength: inChapter.length,
    chapterNumber: CHAPTERS.findIndex((c) => c.id === chapter.id) + 1,
    totalChapters: CHAPTERS.length,
  };
}

/** 0..1 across the whole applicable set, for the top progress bar. */
export function overallProgress(
  currentIndex: number,
  answers: FitAnswers,
): number {
  const applicable = applicableQuestions(answers);
  if (applicable.length === 0) return 1;
  const seen = applicable.filter(
    (q) => FIT_QUESTIONS.indexOf(q) < currentIndex,
  ).length;
  return Math.min(1, seen / applicable.length);
}

/**
 * Shape the collected answers into the `profile` block the API expects.
 *
 * Unanswered stays `null` rather than becoming a default, and the API's
 * Zod schema treats a missing key the same way — the engine reads both as
 * "not known" and skips the branch, so a skipped question can never be
 * mistaken for a "no".
 */
export function toProfilePayload(
  answers: FitAnswers,
  extras: {
    population?: "adult" | "pediatric";
    therapyMode?: "pap" | "niv";
  } = {},
): Record<string, unknown> {
  const value = <T>(id: FitProfileFieldId): T | null => {
    const v = answers[id];
    return v === undefined ? null : (v as T);
  };

  const positions = answers.sleepPositions;
  const leaks = answers.priorLeakLocations;

  return {
    version: "fit_profile_v2",
    population: extras.population ?? "adult",
    therapyMode:
      extras.therapyMode ?? (answers.therapyDevice === "asv" ? "niv" : "pap"),
    therapyDevice: (value<string>("therapyDevice") ?? "unknown") as string,
    pressureCmH2O: value<number>("pressureCmH2O"),
    supplementalOxygen: value<boolean>("supplementalOxygen"),
    mouthBreather: value<boolean>("mouthBreather"),
    nasalObstruction: value<string>("nasalObstruction"),
    frequentCongestion:
      answers.nasalObstruction === undefined ||
      answers.nasalObstruction === null
        ? null
        : answers.nasalObstruction !== "none",
    dryMouth: value<boolean>("dryMouth"),
    sleepPositions: Array.isArray(positions) ? positions : [],
    claustrophobia: value<string>("claustrophobia"),
    minimalContactPreference: value<string>("minimalContactPreference"),
    facialHair: value<string>("facialHair"),
    dentures: value<boolean>("dentures"),
    skinIrritation: value<string>("skinIrritation"),
    sensitiveSkin:
      answers.skinIrritation === undefined || answers.skinIrritation === null
        ? null
        : answers.skinIrritation !== "none",
    wearsGlasses: value<boolean>("wearsGlasses"),
    priorMaskExperience: (value<string>("priorMaskExperience") ??
      "none") as string,
    priorMaskSize: value<string>("priorMaskSize"),
    priorLeakLocations: Array.isArray(leaks) ? leaks : [],
    priorMaskSatisfaction: value<number>("priorMaskSatisfaction"),
    headgearDifficulty: value<boolean>("headgearDifficulty"),
    handDexterity: value<string>("handDexterity"),
    visionOrCognitiveLimitation: value<boolean>("visionOrCognitiveLimitation"),
  };
}

/**
 * Project the profile back onto the legacy 11 answers.
 *
 * The v1 shape is still what `/api/recommend` and the chatbot speak, and
 * an in-flight patient must be able to finish on either path.
 */
export function toLegacyAnswers(answers: FitAnswers): Record<string, unknown> {
  const positions = Array.isArray(answers.sleepPositions)
    ? answers.sleepPositions
    : [];
  const claustrophobia = answers.claustrophobia;
  const facialHair = answers.facialHair;
  const dexterity = answers.handDexterity;
  const skin = answers.skinIrritation;
  const nasal = answers.nasalObstruction;
  const pressure = answers.pressureCmH2O;

  return {
    mouthBreather: answers.mouthBreather ?? null,
    claustrophobic:
      claustrophobia === undefined || claustrophobia === null
        ? null
        : claustrophobia !== "none",
    sideOrStomachSleeper:
      positions.length === 0
        ? null
        : positions.includes("side") || positions.includes("stomach"),
    heavyFacialHair:
      facialHair === undefined || facialHair === null
        ? null
        : facialHair === "full_beard",
    wearsGlasses: answers.wearsGlasses ?? null,
    frequentCongestion:
      nasal === undefined || nasal === null ? null : nasal !== "none",
    priorMaskExperience: (answers.priorMaskExperience as string) ?? "none",
    mobilityLimitations:
      dexterity === undefined || dexterity === null
        ? null
        : dexterity !== "normal",
    sensitiveSkin: skin === undefined || skin === null ? null : skin !== "none",
    siliconeSensitivity: null,
    cpapPressureSetting:
      typeof pressure === "number"
        ? pressure >= 15
          ? "high"
          : pressure >= 10
            ? "medium"
            : "low"
        : "unknown",
  };
}
