// @vitest-environment jsdom
//
// The magnetic-component screen is a clinical gate, not a form, so these
// tests pin the properties that make it one.
//
// Context for why it exists at all: `/api/fit/assess` has always been able
// to demand this screen, but nothing rendered it — `results.tsx` treated
// the `safety_screen_required` reply as a reason to fall back to the
// legacy engine, which has no safety filter. With `fitter.magnet_screening`
// nominally ON, an implant patient could still be handed a mask with
// magnetic headgear clips.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import { SafetyScreen } from "./safety-screen";
import type { SafetyScreenPrompt } from "@/lib/fit-assess-api";

const PROMPT: SafetyScreenPrompt = {
  slug: "magnetic_implant",
  version: "magnetic_implant@v1",
  title: "A couple of safety questions first",
  introCopy: "Some masks use magnetic clips.",
  attestationCopy: "I confirm these answers are accurate.",
  questions: [
    {
      questionKey: "patient_cardiac_device",
      prompt: "Do you have a pacemaker or defibrillator?",
      helpText: "Implanted in your chest.",
      subject: "patient",
      sortOrder: 10,
    },
    {
      questionKey: "household_cardiac_device",
      prompt: "Does anyone who shares your bed have one?",
      helpText: null,
      subject: "household",
      sortOrder: 50,
    },
  ],
};

beforeEach(cleanup);

function renderScreen(onSubmit = vi.fn()) {
  render(<SafetyScreen screen={PROMPT} onSubmit={onSubmit} />);
  return onSubmit;
}

describe("the safety screen never answers for the patient", () => {
  it("starts every question unanswered", () => {
    renderScreen();
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
  });

  it("offers 'Not sure' as a first-class answer on every question", () => {
    renderScreen();
    // Two questions, each with yes/no/unsure.
    expect(screen.getAllByText("Not sure")).toHaveLength(2);
  });

  it("does not submit until every question is answered", () => {
    const onSubmit = renderScreen();
    fireEvent.click(screen.getByTestId("safety-attest"));
    fireEvent.click(screen.getByTestId("safety-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getAllByText("Please answer this before continuing.").length,
    ).toBeGreaterThan(0);
  });

  it("does not submit until the attestation is checked", () => {
    const onSubmit = renderScreen();
    for (const radio of screen.getAllByRole("radio")) {
      if ((radio as HTMLInputElement).value === "no") fireEvent.click(radio);
    }
    fireEvent.click(screen.getByTestId("safety-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Please confirm the statement above before continuing."),
    ).toBeTruthy();
  });
});

describe("the submission the screen produces", () => {
  it("carries every answer, the screen version, and an attestation time", () => {
    const onSubmit = renderScreen();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    // First question yes, second unsure — two different answers so a
    // key/answer transposition would show up.
    fireEvent.click(
      radios.find(
        (r) => r.name === "patient_cardiac_device" && r.value === "yes",
      )!,
    );
    fireEvent.click(
      radios.find(
        (r) => r.name === "household_cardiac_device" && r.value === "unsure",
      )!,
    );
    fireEvent.click(screen.getByTestId("safety-attest"));
    fireEvent.click(screen.getByTestId("safety-submit"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submission = onSubmit.mock.calls[0]![0];
    expect(submission.screenVersion).toBe("magnetic_implant@v1");
    expect(Number.isNaN(Date.parse(submission.attestedAt))).toBe(false);
    expect(submission.responses).toEqual([
      { questionKey: "patient_cardiac_device", answer: "yes" },
      { questionKey: "household_cardiac_device", answer: "unsure" },
    ]);
  });

  it("labels the household questions as being about someone else", () => {
    renderScreen();
    // The risk is proximity, so a patient skimming must not answer the
    // household question about themselves.
    expect(
      screen.getByText("About anyone who shares your bed or handles your mask"),
    ).toBeTruthy();
  });
});

describe("the screen offers no way past itself", () => {
  it("renders no skip, dismiss, or continue-without-answering control", () => {
    renderScreen();
    const labels = screen
      .getAllByRole("button")
      .map((b) => (b.textContent ?? "").toLowerCase());
    for (const label of labels) {
      expect(label).not.toMatch(/skip|dismiss|later|not now|no thanks/);
    }
  });
});
