import { describe, expect, it } from "vitest";

import {
  COMFORT_GUARANTEE_DAYS,
  evaluateAutoApprovalRules,
  isWithinComfortGuarantee,
  type AutoApprovalInput,
} from "./return-window";

function input(overrides: Partial<AutoApprovalInput> = {}): AutoApprovalInput {
  return {
    reason: "defective",
    ageDays: 2,
    priorApprovedReturnsLast90d: 0,
    orderValueCents: 5000,
    ...overrides,
  };
}

describe("isWithinComfortGuarantee", () => {
  it("accepts inside the window and rejects outside / invalid", () => {
    expect(isWithinComfortGuarantee(0)).toBe(true);
    expect(isWithinComfortGuarantee(COMFORT_GUARANTEE_DAYS)).toBe(true);
    expect(isWithinComfortGuarantee(COMFORT_GUARANTEE_DAYS + 1)).toBe(false);
    expect(isWithinComfortGuarantee(-1)).toBe(false);
    expect(isWithinComfortGuarantee(Number.NaN)).toBe(false);
  });
});

describe("evaluateAutoApprovalRules", () => {
  it("auto-approves a defect in the first week", () => {
    expect(
      evaluateAutoApprovalRules(input({ reason: "defective", ageDays: 7 })),
    ).toEqual({
      autoApprove: true,
      rule: "defective_within_7d",
    });
    expect(
      evaluateAutoApprovalRules(input({ reason: "defective", ageDays: 8 }))
        .autoApprove,
    ).toBe(false);
  });

  it("auto-approves a wrong item within 30 days", () => {
    expect(
      evaluateAutoApprovalRules(input({ reason: "wrong_item", ageDays: 30 }))
        .rule,
    ).toBe("wrong_item_within_30d");
  });

  it("routes fit/no_longer_needed/other to manual review", () => {
    for (const reason of ["fit", "no_longer_needed", "other"] as const) {
      expect(evaluateAutoApprovalRules(input({ reason })).autoApprove).toBe(
        false,
      );
    }
  });

  it("fraud cap and high-value guard short-circuit auto-approval", () => {
    expect(
      evaluateAutoApprovalRules(input({ priorApprovedReturnsLast90d: 3 }))
        .autoApprove,
    ).toBe(false);
    expect(
      evaluateAutoApprovalRules(input({ orderValueCents: 50_000 })).autoApprove,
    ).toBe(false);
  });
});
