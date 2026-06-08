import { describe, it, expect } from "vitest";

import {
  resolveModifiersFromRules,
  ruleApplies,
  type ModifierRuleContext,
  type ModifierRuleRow,
} from "./modifier-rules";

const baseCtx: ModifierRuleContext = {
  rentalMonth: null,
  isPurchased: false,
  isCompliant: false,
  isInitialDispense: false,
  hasPriorAuth: false,
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
      ruleApplies("if_rental_month_ge_4", { ...baseCtx, rentalMonth: 5 }),
    ).toBe(true);
    // Unknown rental month never trips a band rule.
    expect(ruleApplies("if_rental_month_le_3", baseCtx)).toBe(false);
  });

  it("always matches `always`, and abn is opt-in false", () => {
    expect(ruleApplies("always", baseCtx)).toBe(true);
    expect(ruleApplies("if_abn_on_file", baseCtx)).toBe(false);
  });

  it("matches compliance / PA / initial-dispense flags", () => {
    expect(
      ruleApplies("if_compliant_90day", { ...baseCtx, isCompliant: true }),
    ).toBe(true);
    expect(
      ruleApplies("if_pa_approved", { ...baseCtx, hasPriorAuth: true }),
    ).toBe(true);
    expect(
      ruleApplies("if_initial_dispense", {
        ...baseCtx,
        isInitialDispense: true,
      }),
    ).toBe(true);
  });
});

describe("resolveModifiersFromRules", () => {
  const rules: ModifierRuleRow[] = [
    { condition: "always", modifiers_csv: "KX", priority: 10 },
    { condition: "if_rental_month_le_3", modifiers_csv: "KH", priority: 20 },
    { condition: "if_rental_month_ge_4", modifiers_csv: "KI", priority: 20 },
  ];

  it("applies month-1 rental rotation (KX + KH)", () => {
    expect(
      resolveModifiersFromRules(rules, { ...baseCtx, rentalMonth: 1 }),
    ).toEqual(["KX", "KH"]);
  });

  it("applies month-4+ rental rotation (KX + KI)", () => {
    expect(
      resolveModifiersFromRules(rules, { ...baseCtx, rentalMonth: 6 }),
    ).toEqual(["KX", "KI"]);
  });

  it("dedups repeated modifiers and respects priority order", () => {
    const dup: ModifierRuleRow[] = [
      { condition: "always", modifiers_csv: "RT,KX", priority: 5 },
      { condition: "always", modifiers_csv: "KX,LT", priority: 1 },
    ];
    // priority 1 (KX,LT) evaluated before priority 5 (RT,KX); KX deduped.
    expect(resolveModifiersFromRules(dup, baseCtx)).toEqual(["KX", "LT", "RT"]);
  });

  it("ignores malformed CSV entries (non-2-char tokens)", () => {
    const bad: ModifierRuleRow[] = [
      { condition: "always", modifiers_csv: "KX, , TOOLONG, K", priority: 1 },
    ];
    expect(resolveModifiersFromRules(bad, baseCtx)).toEqual(["KX"]);
  });
});
