// @vitest-environment jsdom
//
// Behavioural cover for the adult-or-child gate that now fronts BOTH
// questionnaires.
//
// The thing worth pinning is not that a screen renders — it is that
// NOTHING gets past it. Population selects the measurement plausibility
// window, the tier-1 service-line filter, and the stored fit session's
// service line; every one of those silently defaults to "adult" when it
// is unset, so an un-gated flow does not fail loudly, it fits a child
// with adult masks.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const setLocation = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/questionnaire", setLocation],
}));
const track = vi.fn();
vi.mock("@/lib/track", () => ({
  track: (...args: unknown[]) => track(...args),
}));
vi.mock("@/hooks/use-document-title", () => ({ useDocumentTitle: vi.fn() }));

// A live store double: `population` accumulates exactly as the provider's
// setter would, so the gate's own "answered → move on" transition is
// exercised rather than stubbed.
const store = {
  population: null as "adult" | "pediatric" | null,
  fitProfileV2: false,
  answers: {} as Record<string, unknown>,
};
vi.mock("@/hooks/use-fitter-store", () => ({
  useFitterStore: () => ({
    population: store.population,
    setPopulation: (value: "adult" | "pediatric" | null) => {
      store.population = value;
    },
    fitProfileV2: store.fitProfileV2,
    answers: store.answers,
    updateAnswers: (next: Record<string, unknown>) => {
      store.answers = { ...store.answers, ...next };
    },
  }),
}));

// The v2 flow is a separate page; stub it so this file only ever
// exercises the gate and the v1 hand-off.
vi.mock("@/pages/questionnaire-v2", () => ({
  QuestionnaireV2: ({ onReopenGate }: { onReopenGate?: () => void }) => (
    <div data-testid="questionnaire-v2">
      <button data-testid="v2-back" onClick={() => onReopenGate?.()}>
        back
      </button>
    </div>
  ),
}));

import { Questionnaire } from "./questionnaire";

beforeEach(() => {
  cleanup();
  setLocation.mockReset();
  track.mockReset();
  store.population = null;
  store.fitProfileV2 = false;
  store.answers = {};
});

describe("questionnaire — the adult-or-child gate", () => {
  it("asks before any mask question, on the LEGACY question set", () => {
    render(<Questionnaire />);
    expect(screen.getByTestId("button-population-adult")).toBeTruthy();
    expect(screen.getByTestId("button-population-pediatric")).toBeTruthy();
    // The first legacy question must not be on screen yet.
    expect(screen.queryByTestId("button-priorMaskExperience-none")).toBeNull();
  });

  it("asks before any mask question on the V2 question set too", () => {
    // Both flows need the answer, so it lives once, in front of both.
    store.fitProfileV2 = true;
    render(<Questionnaire />);
    expect(screen.getByTestId("button-population-adult")).toBeTruthy();
    expect(screen.queryByTestId("questionnaire-v2")).toBeNull();
  });

  it("hands off to the legacy questionnaire once answered", () => {
    const { rerender } = render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-adult"));
    rerender(<Questionnaire />);
    expect(store.population).toBe("adult");
    expect(screen.queryByTestId("button-population-adult")).toBeNull();
    expect(screen.getByTestId("button-priorMaskExperience-none")).toBeTruthy();
  });

  it("hands off to the v2 questionnaire once answered", () => {
    store.fitProfileV2 = true;
    const { rerender } = render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-pediatric"));
    rerender(<Questionnaire />);
    expect(store.population).toBe("pediatric");
    expect(screen.getByTestId("questionnaire-v2")).toBeTruthy();
  });

  it("records the SERVICE LINE, never an age or a date of birth", () => {
    render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-pediatric"));
    expect(store.population).toBe("pediatric");
    expect(track).toHaveBeenCalledWith("fitting_population_selected", {
      population: "pediatric",
    });
  });

  it("offers no 'I'm not sure' escape", () => {
    // Every other question in the flow has one, because "declined to
    // answer" is a safe no-op there. Here it is not: a null population
    // has to default to something, and defaulting either way is the
    // mistake this screen exists to prevent.
    render(<Questionnaire />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.queryByText(/not sure/i)).toBeNull();
  });

  it("keeps the two tiles in one radiogroup for assistive tech", () => {
    render(<Questionnaire />);
    const group = screen.getByRole("radiogroup");
    expect(group.getAttribute("aria-labelledby")).toBe("population-gate-label");
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("selects with the 1 / 2 number keys, matching both questionnaires", () => {
    const { rerender } = render(<Questionnaire />);
    fireEvent.keyDown(window, { key: "2" });
    rerender(<Questionnaire />);
    expect(store.population).toBe("pediatric");
  });
});

describe("questionnaire — the gate answer stays correctable", () => {
  // A mis-tap here is not like a mis-tap on any other question: it
  // silently decides which masks are eligible at all, and it survives a
  // reload. Before this, the only correction was a full reset — which a
  // patient has no reason to look for — so a parent who fat-fingered
  // "An adult" would be shown adult masks for their child.
  it("Back from the FIRST legacy question reopens the gate", () => {
    const { rerender } = render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-adult"));
    rerender(<Questionnaire />);
    expect(screen.getByTestId("button-priorMaskExperience-none")).toBeTruthy();

    // The Back control is enabled on question one now, and goes to the
    // gate rather than nowhere.
    const back = screen.getByLabelText("Back to who this fitting is for");
    expect(back.hasAttribute("disabled")).toBe(false);
    fireEvent.click(back);
    rerender(<Questionnaire />);

    expect(store.population).toBeNull();
    expect(screen.getByTestId("button-population-adult")).toBeTruthy();
  });

  it("hands the v2 flow the same way back", () => {
    store.fitProfileV2 = true;
    const { rerender } = render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-adult"));
    rerender(<Questionnaire />);
    fireEvent.click(screen.getByTestId("v2-back"));
    rerender(<Questionnaire />);
    expect(store.population).toBeNull();
    expect(screen.getByTestId("button-population-adult")).toBeTruthy();
  });

  it("shows the previous choice when the gate is reopened", () => {
    // Coming back to a blank gate would make the patient wonder whether
    // their first answer registered at all.
    const { rerender } = render(<Questionnaire />);
    fireEvent.click(screen.getByTestId("button-population-pediatric"));
    rerender(<Questionnaire />);
    fireEvent.click(screen.getByLabelText("Back to who this fitting is for"));
    rerender(<Questionnaire />);
    // Re-answering is what the screen is for; the tiles are live again.
    fireEvent.click(screen.getByTestId("button-population-adult"));
    expect(store.population).toBe("adult");
  });
});
