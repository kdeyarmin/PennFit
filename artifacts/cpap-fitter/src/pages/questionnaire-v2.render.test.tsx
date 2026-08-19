// @vitest-environment jsdom
//
// Behavioural cover for the v2 Patient Fit Profile questionnaire:
//   * the chaptered flow renders and advances through real branching
//     (a first-time user never sees the previous-mask block),
//   * every answer lands in the store's v2 shape with null preserved
//     for "I'm not sure",
//   * completion derives the legacy 11 answers via toLegacyAnswers so
//     downstream v1 consumers keep working, then navigates to /results.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import type { FitAnswers } from "@/lib/fit-profile";

const setLocation = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/questionnaire", setLocation],
}));
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
vi.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: vi.fn() }));

// A live store double: answers accumulate exactly as the provider's
// updaters would accumulate them, so branching sees real state.
const store = {
  fitAnswers: {} as FitAnswers,
  legacyAnswers: {} as Record<string, unknown>,
};
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => ({
    fitAnswers: store.fitAnswers,
    updateFitAnswers: (next: FitAnswers) => {
      store.fitAnswers = { ...store.fitAnswers, ...next };
    },
    updateAnswers: (next: Record<string, unknown>) => {
      store.legacyAnswers = { ...store.legacyAnswers, ...next };
    },
  }),
}));

import { QuestionnaireV2 } from "./questionnaire-v2";

beforeEach(() => {
  cleanup();
  store.fitAnswers = {};
  store.legacyAnswers = {};
  setLocation.mockClear();
});

/** Answer every applicable question with the given picks, re-rendering
 *  between commits the way the live store re-renders the page. */
function clickThrough(picks: Array<() => void>): void {
  for (const pick of picks) pick();
}

describe("QuestionnaireV2", () => {
  it("renders the first chapter and its first question", () => {
    render(<QuestionnaireV2 />);
    expect(screen.getByTestId("fit-profile-chapter").textContent).toContain(
      "Your therapy",
    );
    expect(
      screen.getByText("What kind of machine were you prescribed?"),
    ).toBeTruthy();
  });

  it("records 'I'm not sure' as null, never a default", () => {
    render(<QuestionnaireV2 />);
    fireEvent.click(screen.getByTestId("fit-therapyDevice-unsure"));
    expect(store.fitAnswers.therapyDevice).toBeNull();
  });

  it("walks the whole flow, branching past the previous-mask block for a first-timer, and derives the legacy answers", () => {
    const { rerender } = render(<QuestionnaireV2 />);
    const click = (testId: string) => {
      fireEvent.click(screen.getByTestId(testId));
      rerender(<QuestionnaireV2 />);
    };

    clickThrough([
      () => click("fit-therapyDevice-cpap"),
      // therapyDevice=cpap skips supplementalOxygen; pressure is next.
      () => click("fit-pressureCmH2O-unsure"),
      () => click("fit-mouthBreather-yes"),
      // mouthBreather=true keeps the dryMouth follow-up.
      () => click("fit-nasalObstruction-none"),
      () => click("fit-dryMouth-no"),
      () => click("fit-sleepPositions-side"),
      () => click("fit-sleepPositions-continue"),
      () => click("fit-claustrophobia-none"),
      () => click("fit-minimalContactPreference-minimal"),
      () => click("fit-facialHair-full_beard"),
      () => click("fit-dentures-no"),
      () => click("fit-skinIrritation-none"),
      () => click("fit-wearsGlasses-no"),
      // First mask ever → the size/leaks/satisfaction block never renders.
      () => click("fit-priorMaskExperience-none"),
      () => click("fit-headgearDifficulty-no"),
      () => click("fit-handDexterity-normal"),
      // handDexterity=normal + headgearDifficulty=false skips the
      // vision/cognition follow-up — the flow is complete.
    ]);

    expect(setLocation).toHaveBeenCalledWith("/results");

    // The v2 answers landed as answered...
    expect(store.fitAnswers.mouthBreather).toBe(true);
    expect(store.fitAnswers.sleepPositions).toEqual(["side"]);
    expect(store.fitAnswers.facialHair).toBe("full_beard");
    // ...the skipped block stayed unasked, not defaulted...
    expect(store.fitAnswers.priorLeakLocations).toBeUndefined();
    // ...and the legacy 11 were derived for every v1 consumer.
    expect(store.legacyAnswers.mouthBreather).toBe(true);
    expect(store.legacyAnswers.sideOrStomachSleeper).toBe(true);
    expect(store.legacyAnswers.heavyFacialHair).toBe(true);
    expect(store.legacyAnswers.cpapPressureSetting).toBe("unknown");
  });
});
