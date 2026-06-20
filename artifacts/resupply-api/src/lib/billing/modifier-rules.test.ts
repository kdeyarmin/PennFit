import { describe, it, expect } from "vitest";

import {
  abnCoversHcpcs,
  buildAbnScope,
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
      ruleApplies("if_rental_month_ge_4", { ...baseCtx, rentalMonth: 5 }),
    ).toBe(true);
    // Unknown rental month never trips a band rule.
    expect(ruleApplies("if_rental_month_le_3", baseCtx)).toBe(false);
  });

  it("always matches `always`, and abn tracks the ABN-on-file flag", () => {
    expect(ruleApplies("always", baseCtx)).toBe(true);
    // No ABN on file → the rule stays dormant.
    expect(ruleApplies("if_abn_on_file", baseCtx)).toBe(false);
    // Signed ABN on file → the rule fires (e.g. stamp GA).
    expect(
      ruleApplies("if_abn_on_file", { ...baseCtx, isAbnOnFile: true }),
    ).toBe(true);
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

describe("buildAbnScope / abnCoversHcpcs", () => {
  it("no ABN acks → covers nothing", () => {
    const scope = buildAbnScope([]);
    expect(scope.coversAll).toBe(false);
    expect(abnCoversHcpcs(scope, "E0601")).toBe(false);
  });

  it("a general ABN (null/empty hcpcs_codes) covers every line", () => {
    expect(
      abnCoversHcpcs(buildAbnScope([{ hcpcs_codes: null }]), "E0601"),
    ).toBe(true);
    expect(abnCoversHcpcs(buildAbnScope([{ hcpcs_codes: [] }]), "A7030")).toBe(
      true,
    );
  });

  it("an item-scoped ABN covers only its listed HCPCS", () => {
    const scope = buildAbnScope([{ hcpcs_codes: ["E0601", "A7030"] }]);
    expect(scope.coversAll).toBe(false);
    expect(abnCoversHcpcs(scope, "E0601")).toBe(true);
    expect(abnCoversHcpcs(scope, "A7030")).toBe(true);
    // A different item the patient never signed an ABN for is NOT covered.
    expect(abnCoversHcpcs(scope, "E0470")).toBe(false);
  });

  it("normalises case/whitespace on both sides", () => {
    const scope = buildAbnScope([{ hcpcs_codes: [" e0601 "] }]);
    expect(abnCoversHcpcs(scope, "e0601")).toBe(true);
    expect(abnCoversHcpcs(scope, " E0601")).toBe(true);
  });

  it("a general ABN unions with an item-scoped one → covers all", () => {
    const scope = buildAbnScope([
      { hcpcs_codes: ["E0601"] },
      { hcpcs_codes: null },
    ]);
    expect(scope.coversAll).toBe(true);
    expect(abnCoversHcpcs(scope, "E0470")).toBe(true);
  });
});
