// Mint + normalize stay in lockstep so confirmation emails and
// /track-order accept the same reference the patient was emailed.

import { describe, expect, it } from "vitest";

import { generateOrderReference } from "./orderEmail.js";
import {
  normalizeOrderReference,
  ORDER_REFERENCE_PATTERN,
} from "./orderTracking.js";

describe("generateOrderReference", () => {
  it("mints PENN- + 6 alphanumerics matching ORDER_REFERENCE_PATTERN", () => {
    for (let i = 0; i < 20; i++) {
      const ref = generateOrderReference();
      expect(ref).toMatch(/^PENN-[A-Z0-9]{6}$/);
      expect(ORDER_REFERENCE_PATTERN.test(ref)).toBe(true);
      expect(normalizeOrderReference(ref)).toBe(ref);
    }
  });
});

describe("normalizeOrderReference", () => {
  it("prefixes a bare 6-char tail with PENN-", () => {
    expect(normalizeOrderReference("7K3N9X")).toBe("PENN-7K3N9X");
  });

  it("keeps legacy PHM-XXX-XXX refs as-is (uppercase)", () => {
    expect(normalizeOrderReference("phm-7k3-n9x")).toBe("PHM-7K3-N9X");
  });

  it("rejects short tails that the old SPA validator allowed", () => {
    expect(normalizeOrderReference("AB12")).toBeNull();
    expect(normalizeOrderReference("PENN-AB12")).toBeNull();
  });
});
