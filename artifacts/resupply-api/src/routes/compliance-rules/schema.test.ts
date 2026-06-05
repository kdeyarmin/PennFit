// Unit coverage for the /compliance-rules request validation. The
// threshold semantics (the SQL) are validated separately against the DB;
// here we lock the HTTP input contract — defaults, bounds, and the
// empty-string → null payer normalization.

import { describe, expect, it } from "vitest";

import { complianceRuleBody } from "./create";
import { compliancePatchBody } from "./update";

describe("complianceRuleBody (POST)", () => {
  it("applies CMS defaults when thresholds are omitted", () => {
    const parsed = complianceRuleBody.parse({ name: "Aetna PPO" });
    expect(parsed).toMatchObject({
      name: "Aetna PPO",
      priority: 100,
      minMinutes: 240,
      requiredNights: 21,
      windowDays: 30,
      active: true,
      matchInsurancePayer: null,
      notes: null,
    });
  });

  it("normalizes an empty payer to null (catch-all rule)", () => {
    const parsed = complianceRuleBody.parse({
      name: "Default",
      matchInsurancePayer: "   ",
    });
    expect(parsed.matchInsurancePayer).toBeNull();
  });

  it("accepts a payer-specific rule with custom thresholds", () => {
    const parsed = complianceRuleBody.parse({
      name: "State Medicaid",
      matchInsurancePayer: "PA Medicaid",
      minMinutes: 240,
      requiredNights: 14,
      priority: 200,
    });
    expect(parsed.matchInsurancePayer).toBe("PA Medicaid");
    expect(parsed.requiredNights).toBe(14);
  });

  it("rejects requiredNights outside 1..30", () => {
    expect(
      complianceRuleBody.safeParse({ name: "x", requiredNights: 0 }).success,
    ).toBe(false);
    expect(
      complianceRuleBody.safeParse({ name: "x", requiredNights: 31 }).success,
    ).toBe(false);
  });

  it("rejects minMinutes outside 0..1440", () => {
    expect(
      complianceRuleBody.safeParse({ name: "x", minMinutes: -1 }).success,
    ).toBe(false);
    expect(
      complianceRuleBody.safeParse({ name: "x", minMinutes: 1441 }).success,
    ).toBe(false);
  });

  it("requires a non-empty name", () => {
    expect(complianceRuleBody.safeParse({ name: "" }).success).toBe(false);
    expect(complianceRuleBody.safeParse({}).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(
      complianceRuleBody.safeParse({ name: "x", cadenceDays: 30 }).success,
    ).toBe(false);
  });

  it("defaults windowDays to 30 (the CMS rolling window)", () => {
    expect(complianceRuleBody.parse({ name: "x" }).windowDays).toBe(30);
  });

  it("rejects windowDays outside 7..90", () => {
    expect(
      complianceRuleBody.safeParse({ name: "x", windowDays: 6 }).success,
    ).toBe(false);
    expect(
      complianceRuleBody.safeParse({ name: "x", windowDays: 91 }).success,
    ).toBe(false);
    expect(
      complianceRuleBody.safeParse({
        name: "x",
        requiredNights: 7,
        windowDays: 7,
      }).success,
    ).toBe(true);
  });

  it("rejects requiredNights greater than windowDays (unachievable)", () => {
    expect(
      complianceRuleBody.safeParse({
        name: "x",
        requiredNights: 21,
        windowDays: 14,
      }).success,
    ).toBe(false);
    expect(
      complianceRuleBody.safeParse({
        name: "x",
        requiredNights: 10,
        windowDays: 14,
      }).success,
    ).toBe(true);
  });
});

describe("compliancePatchBody (PATCH)", () => {
  it("allows a partial update (single field)", () => {
    const parsed = compliancePatchBody.parse({ active: false });
    expect(parsed).toEqual({ active: false });
  });

  it("clears payer when an empty string is sent", () => {
    const parsed = compliancePatchBody.parse({ matchInsurancePayer: "" });
    expect(parsed.matchInsurancePayer).toBeNull();
  });

  it("validates expectedUpdatedAt as ISO-8601 when present", () => {
    expect(
      compliancePatchBody.safeParse({ expectedUpdatedAt: "not-a-date" })
        .success,
    ).toBe(false);
    expect(
      compliancePatchBody.safeParse({
        active: true,
        expectedUpdatedAt: "2026-06-05T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("enforces the same threshold bounds as create", () => {
    expect(compliancePatchBody.safeParse({ requiredNights: 99 }).success).toBe(
      false,
    );
    expect(compliancePatchBody.safeParse({ minMinutes: 5000 }).success).toBe(
      false,
    );
    expect(compliancePatchBody.safeParse({ windowDays: 100 }).success).toBe(
      false,
    );
    expect(compliancePatchBody.safeParse({ windowDays: 60 }).success).toBe(
      true,
    );
  });
});
