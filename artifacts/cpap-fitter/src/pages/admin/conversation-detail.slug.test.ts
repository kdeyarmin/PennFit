// Tests for slugifyMacroKey — the save-as-macro key suggester (#14).
// The server requires /^[a-z0-9][a-z0-9_-]*$/, 2–60 chars; this helper
// derives a valid suggestion from a free-text label.

import { describe, it, expect } from "vitest";

import { slugifyMacroKey } from "./conversation-detail";

const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

describe("slugifyMacroKey", () => {
  it("lower-cases and dashes a normal label", () => {
    expect(slugifyMacroKey("Leak Troubleshooting")).toBe(
      "leak-troubleshooting",
    );
  });

  it("collapses runs of punctuation/space into a single dash", () => {
    expect(slugifyMacroKey("Mask fit — re-check!!")).toBe("mask-fit-re-check");
  });

  it("trims leading/trailing separators and leading non-alphanumerics", () => {
    expect(slugifyMacroKey("  --Hello--  ")).toBe("hello");
    expect(slugifyMacroKey("123 go")).toBe("123-go");
    // A label that starts with punctuation must not yield a leading dash.
    expect(slugifyMacroKey("!!! urgent")).toBe("urgent");
  });

  it("caps the key at 60 characters", () => {
    const long = "a".repeat(200);
    expect(slugifyMacroKey(long).length).toBe(60);
  });

  it("always produces a server-valid key (or empty) for assorted labels", () => {
    for (const label of [
      "Leak Troubleshooting",
      "Mask fit — re-check!!",
      "CO-pay reminder (2026)",
      "résumé follow-up",
      "   ",
    ]) {
      const key = slugifyMacroKey(label);
      if (key.length > 0) expect(key).toMatch(KEY_RE);
    }
  });
});
