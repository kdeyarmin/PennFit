import { describe, it, expect } from "vitest";

import {
  normalizeModifiers,
  validateModifierCombination,
  type ModifierConflictCode,
} from "./modifier-validation";

const codes = (mods: readonly string[] | string): ModifierConflictCode[] =>
  validateModifierCombination(mods)
    .map((c) => c.code)
    .sort();

describe("normalizeModifiers", () => {
  it("uppercases, trims, drops non-2-char tokens, and de-dupes", () => {
    expect(
      normalizeModifiers(["rr", " KX ", "K", "TOOLONG", "kx", ""]),
    ).toEqual(["RR", "KX"]);
  });
});

describe("validateModifierCombination — clean lines", () => {
  it("accepts a compliant capped-rental month-1 line", () => {
    expect(validateModifierCombination(["RR", "KH", "KX"])).toEqual([]);
  });

  it("accepts a purchased-new resupply line", () => {
    expect(validateModifierCombination(["NU", "KX"])).toEqual([]);
  });

  it("accepts a single liability modifier (GA on file)", () => {
    expect(validateModifierCombination(["GA"])).toEqual([]);
  });

  it("accepts the valid voluntary-notice GX+GY pairing", () => {
    // GX (voluntary notice) pairs with GY (statutorily excluded) — allowed.
    expect(validateModifierCombination(["GX", "GY"])).toEqual([]);
  });

  it("accepts an empty / missing modifier set", () => {
    expect(validateModifierCombination([])).toEqual([]);
    expect(validateModifierCombination(null)).toEqual([]);
    expect(validateModifierCombination(undefined)).toEqual([]);
    expect(validateModifierCombination("")).toEqual([]);
  });
});

describe("validateModifierCombination — hard contradictions", () => {
  it("flags KX with a liability modifier (the documented hard-reject trap)", () => {
    expect(codes(["KX", "GA"])).toEqual(["kx_with_liability"]);
    expect(codes(["KX", "GZ"])).toEqual(["kx_with_liability"]);
    expect(codes(["KX", "GY"])).toEqual(["kx_with_liability"]);
    expect(codes("RR,KX,GX")).toEqual(["kx_with_liability"]);
  });

  it("names every offending modifier in the KX+liability conflict", () => {
    const [conflict] = validateModifierCombination(["KX", "GA", "GZ"]);
    // KX + both liability modifiers: the KX conflict lists all of them.
    expect(conflict?.code).toBe("kx_with_liability");
    expect(conflict?.modifiers).toEqual(
      expect.arrayContaining(["KX", "GA", "GZ"]),
    );
  });

  it("flags two primary liability modifiers as mutually exclusive", () => {
    expect(codes(["GA", "GZ"])).toEqual(["liability_modifier_exclusive"]);
    expect(codes(["GA", "GY"])).toEqual(["liability_modifier_exclusive"]);
  });

  it("flags rental + purchase on the same line", () => {
    expect(codes(["RR", "NU"])).toEqual(["rental_with_purchase"]);
    expect(codes(["RR", "UE"])).toEqual(["rental_with_purchase"]);
  });

  it("flags new + used purchase on the same line", () => {
    expect(codes(["NU", "UE"])).toEqual(["purchase_new_used_exclusive"]);
  });

  it("flags more than one capped-rental month band", () => {
    expect(codes(["RR", "KH", "KI"])).toEqual([
      "capped_rental_month_exclusive",
    ]);
    expect(codes(["KI", "KJ"])).toEqual(["capped_rental_month_exclusive"]);
  });

  it("returns ALL conflicts on a badly-built line at once", () => {
    // RR+NU (rental+purchase), GA+GZ (liability), KX+GA (kx+liability),
    // KH+KI (month band) — four independent problems.
    expect(codes(["RR", "NU", "GA", "GZ", "KX", "KH", "KI"])).toEqual([
      "capped_rental_month_exclusive",
      "kx_with_liability",
      "liability_modifier_exclusive",
      "rental_with_purchase",
    ]);
  });

  it("accepts a comma-joined string (the stored line shape)", () => {
    expect(validateModifierCombination("RR,KH,KX")).toEqual([]);
    expect(codes("KX,GA")).toEqual(["kx_with_liability"]);
  });
});
