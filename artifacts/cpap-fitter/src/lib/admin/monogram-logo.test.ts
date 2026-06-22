import { describe, expect, it } from "vitest";

import { colorForName, deriveInitials } from "./monogram-logo";

describe("deriveInitials", () => {
  it("takes the first letters of the first two significant words", () => {
    expect(deriveInitials("Penn Home Medical Supply")).toBe("PH");
    expect(deriveInitials("Acme CPAP")).toBe("AC");
  });

  it("skips filler words and legal suffixes", () => {
    expect(deriveInitials("The Sleep Co")).toBe("SL"); // "co" + "the" dropped
    expect(deriveInitials("Restful Nights LLC")).toBe("RN");
    expect(deriveInitials("Air & Rest")).toBe("AR");
  });

  it("uses two letters of a single-word name", () => {
    expect(deriveInitials("Acme")).toBe("AC");
    expect(deriveInitials("PennPaps")).toBe("PE");
  });

  it("handles a single-letter word", () => {
    expect(deriveInitials("Q")).toBe("Q");
  });

  it("falls back to a dot for empty / symbol-only input", () => {
    expect(deriveInitials("")).toBe("•");
    expect(deriveInitials("   ")).toBe("•");
    expect(deriveInitials("!!!")).toBe("•");
  });

  it("ignores punctuation between words", () => {
    expect(deriveInitials("Smith, Jones & Co.")).toBe("SJ");
  });
});

describe("colorForName", () => {
  it("is deterministic for the same name", () => {
    expect(colorForName("Acme CPAP")).toBe(colorForName("Acme CPAP"));
  });

  it("returns an in-range hsl with fixed saturation/lightness", () => {
    const m = colorForName("Penn Home Medical Supply").match(
      /^hsl\((\d+), 45%, 32%\)$/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(0);
    expect(Number(m![1])).toBeLessThan(360);
  });

  it("varies the hue across different names", () => {
    expect(colorForName("Acme")).not.toBe(colorForName("Globex Sleep"));
  });
});
