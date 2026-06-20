import { describe, expect, it } from "vitest";

import {
  parseReview,
  reviewSmartNote,
  compareSmartNote,
  SMART_NOTE_ELEMENTS,
  type SmartNoteChartContext,
} from "./smart-note-compliance";

const EMPTY_CHART: SmartNoteChartContext = {
  patientStatus: "active",
  latestSleepStudy: null,
  adherence: null,
};

describe("parseReview", () => {
  it("reconciles every required element and fails closed on omissions", () => {
    // Model only returns two of the nine required keys; the rest must
    // default to present:false and count against compliance.
    const content = JSON.stringify({
      summary: "Partial documentation.",
      elements: [
        { key: "osa_diagnosis", present: true, detail: "OSA, AHI 32" },
        { key: "adherence_data", present: true, detail: "6.1h/night, 90%" },
      ],
      suggestions: ["Add provider signature."],
      chartConsistency: { summary: "Matches", discrepancies: [] },
    });

    const review = parseReview(content, "anthropic");

    expect(review.elements).toHaveLength(SMART_NOTE_ELEMENTS.length);
    const present = review.elements.filter((e) => e.present);
    expect(present.map((e) => e.key).sort()).toEqual([
      "adherence_data",
      "osa_diagnosis",
    ]);
    expect(review.compliant).toBe(false);
    expect(review.score).toBe(
      Math.round((2 / SMART_NOTE_ELEMENTS.length) * 100),
    );
    expect(review.missingElements.length).toBe(SMART_NOTE_ELEMENTS.length - 2);
    expect(review.provider).toBe("anthropic");
  });

  it("marks compliant when every element is present", () => {
    const content = JSON.stringify({
      summary: "Complete.",
      elements: SMART_NOTE_ELEMENTS.map((e) => ({
        key: e.key,
        present: true,
        detail: "documented",
      })),
      suggestions: [],
      chartConsistency: { summary: "", discrepancies: [] },
    });

    const review = parseReview(content, "openai");
    expect(review.compliant).toBe(true);
    expect(review.score).toBe(100);
    expect(review.missingElements).toEqual([]);
  });

  it("tolerates JSON wrapped in prose / markdown fences", () => {
    const content =
      "Here is the review:\n```json\n" +
      JSON.stringify({
        summary: "ok",
        elements: [{ key: "subjective_findings", present: true, detail: "x" }],
        suggestions: [],
        chartConsistency: { summary: "", discrepancies: [] },
      }) +
      "\n```";
    const review = parseReview(content, "anthropic");
    expect(
      review.elements.find((e) => e.key === "subjective_findings")?.present,
    ).toBe(true);
  });

  it("fails closed (all missing) on malformed JSON", () => {
    const review = parseReview("not json at all", "anthropic");
    expect(review.compliant).toBe(false);
    expect(review.score).toBe(0);
    expect(review.elements.every((e) => !e.present)).toBe(true);
  });
});

describe("reviewSmartNote offline", () => {
  it("falls back to the heuristic checklist when no provider configured", async () => {
    const prev = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const review = await reviewSmartNote({
        noteText:
          "Patient reports improved daytime sleepiness. Device download shows 6.5 hours per night, AHI 3.2. Plan: continue CPAP, follow-up in 30 days. Signed J. Doe RN.",
        chart: EMPTY_CHART,
      });
      expect(review.provider).toBe("offline");
      // The note clearly mentions benefit + adherence + plan + RN, so
      // those heuristic keys should register as present.
      const byKey = new Map(review.elements.map((e) => [e.key, e.present]));
      expect(byKey.get("clinical_benefit")).toBe(true);
      expect(byKey.get("adherence_data")).toBe(true);
      expect(byKey.get("interventions_plan")).toBe(true);
      expect(byKey.get("provider_attestation")).toBe(true);
    } finally {
      if (prev.ANTHROPIC_API_KEY !== undefined)
        process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      if (prev.OPENAI_API_KEY !== undefined)
        process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
    }
  });
});

describe("compareSmartNote", () => {
  it("returns a first-note comparison when there is no previous note", async () => {
    const cmp = await compareSmartNote({
      noteText: "first note",
      previous: null,
    });
    expect(cmp.previousNoteId).toBeNull();
    expect(cmp.changes).toEqual([]);
    expect(cmp.summary).toMatch(/first/i);
  });
});
