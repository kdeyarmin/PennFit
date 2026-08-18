// The Patient Fit Profile question set.
//
// Two properties matter here and they pull against each other: the profile
// has to be deep enough to be clinically useful, and short enough that
// patients finish it. So the tests pin both — the branching keeps the
// median path short, and the mapping never turns a skipped question into
// a definite answer.

import { describe, expect, it } from "vitest";

import {
  applicableQuestions,
  chapterProgress,
  CHAPTERS,
  FIT_QUESTIONS,
  nextQuestionIndex,
  previousQuestionIndex,
  questionApplies,
  toLegacyAnswers,
  toProfilePayload,
  type FitAnswers,
} from "./fit-profile";

/** Answers a first-time user with nothing remarkable would give. */
const TYPICAL: FitAnswers = {
  therapyDevice: "cpap",
  pressureCmH2O: 10,
  mouthBreather: false,
  nasalObstruction: "none",
  sleepPositions: ["side"],
  claustrophobia: "none",
  minimalContactPreference: "no_preference",
  facialHair: "none",
  dentures: false,
  skinIrritation: "none",
  wearsGlasses: false,
  priorMaskExperience: "none",
  headgearDifficulty: false,
  handDexterity: "normal",
};

describe("question set shape", () => {
  it("covers every chapter and has no duplicate ids", () => {
    const ids = FIT_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const chapter of CHAPTERS) {
      if (chapter.id === "safety") continue; // server-supplied, not in this file
      expect(FIT_QUESTIONS.some((q) => q.chapter === chapter.id)).toBe(true);
    }
  });

  it("gives every single-choice question its options", () => {
    for (const q of FIT_QUESTIONS) {
      if (q.kind === "single" || q.kind === "multi") {
        expect(q.options?.length ?? 0).toBeGreaterThan(1);
      }
    }
  });
});

describe("branching keeps the path short", () => {
  it("shows the typical patient meaningfully fewer than the full set", () => {
    const shown = applicableQuestions(TYPICAL);
    expect(shown.length).toBeLessThan(FIT_QUESTIONS.length);
    expect(shown.length).toBeLessThanOrEqual(15);
  });

  it("hides the previous-mask block from a first-time user", () => {
    const shown = applicableQuestions(TYPICAL).map((q) => q.id);
    expect(shown).not.toContain("priorMaskSize");
    expect(shown).not.toContain("priorLeakLocations");
    expect(shown).not.toContain("priorMaskSatisfaction");
  });

  it("shows the previous-mask block to someone who has worn one", () => {
    const shown = applicableQuestions({
      ...TYPICAL,
      priorMaskExperience: "fullFace",
    }).map((q) => q.id);
    expect(shown).toContain("priorMaskSize");
    expect(shown).toContain("priorLeakLocations");
    expect(shown).toContain("priorMaskSatisfaction");
  });

  it("skips dry mouth once the patient says they don't mouth-breathe", () => {
    expect(
      questionApplies(FIT_QUESTIONS.find((q) => q.id === "dryMouth")!, {
        mouthBreather: false,
      }),
    ).toBe(false);
    expect(
      questionApplies(FIT_QUESTIONS.find((q) => q.id === "dryMouth")!, {
        mouthBreather: true,
      }),
    ).toBe(true);
  });

  it("still asks a safety-relevant question when the prerequisite is unanswered", () => {
    // An unanswered device question must never silently skip the oxygen
    // question — skipping on "unknown" is how a real risk gets missed.
    expect(
      questionApplies(
        FIT_QUESTIONS.find((q) => q.id === "supplementalOxygen")!,
        {},
      ),
    ).toBe(true);
  });

  it("only asks about vision or memory when handling looks difficult", () => {
    const q = FIT_QUESTIONS.find(
      (v) => v.id === "visionOrCognitiveLimitation",
    )!;
    expect(questionApplies(q, { handDexterity: "normal" })).toBe(false);
    expect(questionApplies(q, { handDexterity: "limited" })).toBe(true);
    expect(questionApplies(q, { headgearDifficulty: true })).toBe(true);
  });
});

describe("navigation", () => {
  it("walks forward through only the applicable questions and terminates", () => {
    const visited: string[] = [];
    let index: number | null = 0;
    let guard = 0;
    while (index !== null && guard < 100) {
      visited.push(FIT_QUESTIONS[index]!.id);
      index = nextQuestionIndex(index, TYPICAL);
      guard += 1;
    }
    expect(index).toBeNull();
    expect(visited).not.toContain("priorMaskSize");
    expect(new Set(visited).size).toBe(visited.length);
  });

  it("walks back to the same questions it walked forward through", () => {
    const first = nextQuestionIndex(0, TYPICAL)!;
    const second = nextQuestionIndex(first, TYPICAL)!;
    expect(previousQuestionIndex(second, TYPICAL)).toBe(first);
  });

  it("returns null at the start when walking backwards", () => {
    expect(previousQuestionIndex(0, TYPICAL)).toBeNull();
  });
});

describe("chapter progress", () => {
  it("reports position within a chapter, not across the whole set", () => {
    const progress = chapterProgress(0, TYPICAL)!;
    expect(progress.chapter.id).toBe("therapy");
    expect(progress.chapterNumber).toBe(1);
    expect(progress.totalChapters).toBe(CHAPTERS.length);
    expect(progress.chapterLength).toBeLessThanOrEqual(5);
  });

  it("counts only applicable questions in the chapter length", () => {
    const firstTimer = chapterProgress(
      FIT_QUESTIONS.findIndex((q) => q.id === "priorMaskExperience"),
      TYPICAL,
    )!;
    const veteran = chapterProgress(
      FIT_QUESTIONS.findIndex((q) => q.id === "priorMaskExperience"),
      { ...TYPICAL, priorMaskExperience: "nasal" },
    )!;
    expect(veteran.chapterLength).toBeGreaterThan(firstTimer.chapterLength);
  });
});

describe("payload mapping", () => {
  it("keeps an unanswered question null rather than defaulting it", () => {
    // The engine reads null as "not known" and skips the branch. A false
    // here would silently become a clinical claim the patient never made.
    const payload = toProfilePayload({});
    expect(payload.mouthBreather).toBeNull();
    expect(payload.dentures).toBeNull();
    expect(payload.pressureCmH2O).toBeNull();
    expect(payload.sleepPositions).toEqual([]);
  });

  it("carries the full answer set through", () => {
    const payload = toProfilePayload({
      ...TYPICAL,
      priorMaskExperience: "fullFace",
      priorLeakLocations: ["bridge_of_nose", "cheeks"],
      priorMaskSatisfaction: 2,
    });
    expect(payload.version).toBe("fit_profile_v2");
    expect(payload.priorLeakLocations).toEqual(["bridge_of_nose", "cheeks"]);
    expect(payload.priorMaskSatisfaction).toBe(2);
    expect(payload.pressureCmH2O).toBe(10);
  });

  it("routes an ASV prescription to the NIV service line", () => {
    expect(toProfilePayload({ therapyDevice: "asv" }).therapyMode).toBe("niv");
    expect(toProfilePayload({ therapyDevice: "cpap" }).therapyMode).toBe("pap");
  });

  it("derives the coarse congestion flag without inventing an answer", () => {
    expect(toProfilePayload({}).frequentCongestion).toBeNull();
    expect(
      toProfilePayload({ nasalObstruction: "none" }).frequentCongestion,
    ).toBe(false);
    expect(
      toProfilePayload({ nasalObstruction: "chronic" }).frequentCongestion,
    ).toBe(true);
  });
});

describe("legacy projection", () => {
  it("maps the v2 answers onto the original eleven", () => {
    const legacy = toLegacyAnswers({
      ...TYPICAL,
      claustrophobia: "severe",
      facialHair: "full_beard",
      sleepPositions: ["side", "stomach"],
      pressureCmH2O: 16,
    });
    expect(legacy.claustrophobic).toBe(true);
    expect(legacy.heavyFacialHair).toBe(true);
    expect(legacy.sideOrStomachSleeper).toBe(true);
    expect(legacy.cpapPressureSetting).toBe("high");
  });

  it("does not turn 'not a side sleeper' into 'sleeps on their back'", () => {
    // An empty position list means the patient did not say. Inferring a
    // back sleeper from it would change the recommendation for everyone
    // who skipped that screen.
    expect(toLegacyAnswers({}).sideOrStomachSleeper).toBeNull();
    expect(
      toLegacyAnswers({ sleepPositions: [] }).sideOrStomachSleeper,
    ).toBeNull();
    expect(
      toLegacyAnswers({ sleepPositions: ["back"] }).sideOrStomachSleeper,
    ).toBe(false);
  });

  it("reads a moustache as facial hair but not as a heavy beard", () => {
    expect(toLegacyAnswers({ facialHair: "moustache" }).heavyFacialHair).toBe(
      false,
    );
    expect(toLegacyAnswers({ facialHair: "full_beard" }).heavyFacialHair).toBe(
      true,
    );
  });

  it("leaves the pressure band unknown when no pressure was given", () => {
    expect(toLegacyAnswers({}).cpapPressureSetting).toBe("unknown");
  });
});
