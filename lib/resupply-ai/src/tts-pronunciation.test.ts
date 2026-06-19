import { describe, expect, it } from "vitest";

import {
  applyPronunciation,
  createPronunciationStream,
} from "./tts-pronunciation";

describe("applyPronunciation", () => {
  it("rewrites CPAP/BiPAP/APAP initialisms to syllabic spellings", () => {
    expect(applyPronunciation("Your CPAP is due.")).toBe("Your see-pap is due.");
    expect(applyPronunciation("a BiPAP machine")).toBe("a bye-pap machine");
    expect(applyPronunciation("APAP mode")).toBe("ay-pap mode");
  });

  it("is case-insensitive but only matches whole words", () => {
    expect(applyPronunciation("cpap")).toBe("see-pap");
    // No standalone term → unchanged (no substring rewrite inside a word).
    expect(applyPronunciation("CPAPing")).toBe("CPAPing");
  });

  it("rewrites ResMed and Bi-PAP variants", () => {
    expect(applyPronunciation("a ResMed AirSense")).toBe(
      "a Rezz-med AirSense",
    );
    expect(applyPronunciation("Bi-PAP")).toBe("bye-pap");
  });

  it("leaves text with no domain terms untouched", () => {
    expect(applyPronunciation("want me to send those out?")).toBe(
      "want me to send those out?",
    );
  });

  it("rewrites multiple occurrences in one chunk", () => {
    expect(applyPronunciation("CPAP and CPAP")).toBe("see-pap and see-pap");
  });
});

describe("createPronunciationStream", () => {
  it("rewrites a term even when split across two pushes", () => {
    const s = createPronunciationStream();
    let out = "";
    out += s.push("I'll send a CP");
    out += s.push("AP machine "); // space completes the word "CPAP"
    out += s.flush();
    expect(out).toBe("I'll send a see-pap machine ");
  });

  it("holds the trailing partial word until whitespace arrives", () => {
    const s = createPronunciationStream();
    // No whitespace yet → nothing safe to emit.
    expect(s.push("ResMed")).toBe("");
    // Whitespace arrives → the held word is now whole and gets rewritten;
    // "brand" (still no trailing whitespace) stays buffered.
    expect(s.push(" is the brand")).toBe("Rezz-med is the ");
    expect(s.flush()).toBe("brand");
  });

  it("flush emits and clears the buffered tail", () => {
    const s = createPronunciationStream();
    // "a " emits immediately; "CPAP" (no trailing space) stays buffered.
    expect(s.push("a CPAP")).toBe("a ");
    expect(s.flush()).toBe("see-pap");
    expect(s.flush()).toBe("");
  });

  it("concatenated stream output equals the whole-text transform", () => {
    const s = createPronunciationStream();
    const deltas = ["Your ", "CP", "AP", " and ", "Bi", "PAP", " are due."];
    let streamed = "";
    for (const d of deltas) streamed += s.push(d);
    streamed += s.flush();
    expect(streamed).toBe(applyPronunciation("Your CPAP and BiPAP are due."));
  });
});
