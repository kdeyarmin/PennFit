import { describe, expect, it } from "vitest";

import {
  abnCoversHcpcs,
  buildAbnScope,
  type ModifierRuleContext,
  resolveModifiersFromRules,
  ruleApplies,
} from "./payer-modifiers";

const baseCtx: ModifierRuleContext = {
  rentalMonth: null,
  isPurchased: false,
  isCompliant: false,
  isInitialDispense: false,
  hasPriorAuth: false,
  isAbnOnFile: false,
};

describe("ruleApplies", () => {
  it("matches rental-month bands", () => {
    expect(
      ruleApplies("if_rental_month_le_3", { ...baseCtx, rentalMonth: 2 }),
    ).toBe(true);
    expect(
      ruleApplies("if_rental_month_le_3", { ...baseCtx, rentalMonth: 4 }),
    ).toBe(false);
    expect(
      ruleApplies("if_rental_month_ge_4", { ...baseCtx, rentalMonth: 4 }),
    ).toBe(true);
    expect(
      ruleApplies("if_rental_month_ge_4", { ...baseCtx, rentalMonth: null }),
    ).toBe(false);
  });

  it("always applies for 'always'", () => {
    expect(ruleApplies("always", baseCtx)).toBe(true);
  });
});

describe("resolveModifiersFromRules", () => {
  it("merges applicable rules in priority order, deduped + uppercased", () => {
    const mods = resolveModifiersFromRules(
      [
        { condition: "if_compliant_90day", modifiers_csv: "kx", priority: 2 },
        { condition: "always", modifiers_csv: "RR, kh", priority: 1 },
        { condition: "if_purchased", modifiers_csv: "NU", priority: 3 },
      ],
      { ...baseCtx, isCompliant: true },
    );
    expect(mods).toEqual(["RR", "KH", "KX"]);
  });

  it("drops non-2-char tokens", () => {
    const mods = resolveModifiersFromRules(
      [{ condition: "always", modifiers_csv: "RR, X, KHH", priority: 1 }],
      baseCtx,
    );
    expect(mods).toEqual(["RR"]);
  });
});

describe("buildAbnScope / abnCoversHcpcs", () => {
  it("treats an empty/NULL hcpcs row as a general ABN covering all", () => {
    const scope = buildAbnScope([{ hcpcs_codes: null }]);
    expect(scope.coversAll).toBe(true);
    expect(abnCoversHcpcs(scope, "E0601")).toBe(true);
  });

  it("scopes an item-specific ABN to its codes", () => {
    const scope = buildAbnScope([{ hcpcs_codes: ["e0601"] }]);
    expect(scope.coversAll).toBe(false);
    expect(abnCoversHcpcs(scope, "E0601")).toBe(true);
    expect(abnCoversHcpcs(scope, "A7032")).toBe(false);
  });
});
