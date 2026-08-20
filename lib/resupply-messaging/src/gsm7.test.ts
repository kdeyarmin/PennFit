import { describe, it, expect } from "vitest";

import { toGsm7, isGsm7, gsm7Length, clampToOneSegment } from "./gsm7";

describe("toGsm7", () => {
  it("leaves plain ASCII untouched", () => {
    const s = "Reply YES to ship. EDIT to fix your address. STOP to opt out.";
    expect(toGsm7(s)).toBe(s);
  });

  it("keeps accented letters the GSM-7 alphabet already contains", () => {
    // A tenant spelled with these costs nothing extra, so folding them
    // would mangle the brand for no benefit.
    for (const s of ["Café", "München", "Muñoz", "Ångström", "Straße"]) {
      expect(toGsm7(s)).toBe(s);
      expect(isGsm7(s)).toBe(true);
    }
  });

  it("folds typographic punctuation to its ASCII equivalent", () => {
    expect(toGsm7("Thanks — we'll review")).toBe("Thanks - we'll review");
    expect(toGsm7("wait…")).toBe("wait...");
    expect(toGsm7("“quoted” and ‘single’")).toBe("\"quoted\" and 'single'");
    expect(toGsm7("a b")).toBe("a b");
  });

  it("reduces unrepresentable accents to their base letter", () => {
    // i-acute and c-cedilla are NOT in GSM-7; keep the letter, not nothing.
    expect(toGsm7("Clínica")).toBe("Clinica");
    expect(toGsm7("Provençal")).toBe("Provencal");
  });

  it("drops characters with no sensible fallback rather than passing them through", () => {
    expect(toGsm7("done 🎉")).toBe("done ");
    expect(isGsm7(toGsm7("done 🎉"))).toBe(true);
  });

  it("is idempotent", () => {
    const once = toGsm7("Thanks — “done” 🎉 Clínica…");
    expect(toGsm7(once)).toBe(once);
    expect(isGsm7(once)).toBe(true);
  });
});

describe("gsm7Length", () => {
  it("counts extension-table characters twice", () => {
    expect(gsm7Length("abc")).toBe(3);
    expect(gsm7Length("a{b}")).toBe(3 + 2 + 1); // { and } cost 2 each
  });

  it("returns null for text that is not representable", () => {
    expect(gsm7Length("Thanks — done")).toBeNull();
  });
});

describe("clampToOneSegment", () => {
  it("returns short text unchanged", () => {
    expect(clampToOneSegment("Thanks. We will text tracking.")).toBe(
      "Thanks. We will text tracking.",
    );
  });

  it("folds and clamps over-long text into one segment", () => {
    const long = "Thanks — " + "supplies ".repeat(40);
    const out = clampToOneSegment(long);
    expect(isGsm7(out)).toBe(true);
    expect(gsm7Length(out)!).toBeLessThanOrEqual(160);
    expect(out.endsWith("...")).toBe(true);
    // ASCII tail, never the single ellipsis character that would itself
    // force UCS-2 and defeat the whole point of clamping.
    expect(out).not.toContain("…");
  });

  it("does not cut mid-word when a boundary is available", () => {
    const long = "word ".repeat(60);
    const out = clampToOneSegment(long);
    expect(out.endsWith("word...")).toBe(true);
  });

  it("clamps text that is only over-long after folding", () => {
    // 158 chars of ASCII plus one ellipsis: fits before folding, but the
    // ellipsis expands to three characters and pushes it over.
    const s = "x".repeat(158) + "…";
    expect(s.length).toBe(159);
    const out = clampToOneSegment(s);
    expect(gsm7Length(out)!).toBeLessThanOrEqual(160);
    expect(isGsm7(out)).toBe(true);
  });

  it("honours a custom septet budget", () => {
    const out = clampToOneSegment("a".repeat(200), 70);
    expect(gsm7Length(out)!).toBeLessThanOrEqual(70);
  });
});
