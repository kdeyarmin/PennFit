import { describe, expect, it } from "vitest";

import {
  type OutreachPatient,
  type OutreachPrescription,
  type OutreachRule,
  resolveOutreachPlan,
} from "./outreach-plan";

const NOW = new Date("2026-04-28T12:00:00Z");

function basePatient(overrides: Partial<OutreachPatient> = {}): OutreachPatient {
  return {
    id: "p1",
    // Default: ~400 days (well over 1 year tenured).
    createdAt: new Date("2025-03-23T12:00:00Z"),
    insurancePayer: null,
    cadenceOverrideDays: null,
    channelPreference: null,
    hasPhone: true,
    ...overrides,
  };
}

function basePrescription(
  overrides: Partial<OutreachPrescription> = {},
): OutreachPrescription {
  return {
    itemSku: "MASK-NASAL-MED",
    cadenceDays: 90,
    ...overrides,
  };
}

function rule(overrides: Partial<OutreachRule> = {}): OutreachRule {
  return {
    id: "r1",
    priority: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    active: true,
    matchItemSkuPrefix: null,
    matchInsurancePayer: null,
    minTenureDays: null,
    maxTenureDays: null,
    cadenceDays: 60,
    defaultChannel: null,
    ...overrides,
  };
}

describe("resolveOutreachPlan — fallback (no rules, no override)", () => {
  it("uses prescription cadence and SMS when phone present", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription(),
      rules: [],
      now: NOW,
    });
    expect(plan).toEqual({
      cadenceDays: 90,
      cadenceSource: "prescription",
      channel: "sms",
      channelSource: "default_sms",
      matchedRuleId: null,
    });
  });

  it("falls back to email when patient has no phone", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient({ hasPhone: false }),
      prescription: basePrescription(),
      rules: [],
      now: NOW,
    });
    expect(plan.channel).toBe("email");
    expect(plan.channelSource).toBe("default_email");
  });
});

describe("resolveOutreachPlan — patient overrides win", () => {
  it("override cadence beats matching rule and prescription", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient({ cadenceOverrideDays: 14 }),
      prescription: basePrescription(),
      rules: [rule({ cadenceDays: 60 })],
      now: NOW,
    });
    expect(plan.cadenceDays).toBe(14);
    expect(plan.cadenceSource).toBe("patient_override");
  });

  it("override channel beats matching rule's defaultChannel", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient({ channelPreference: "voice" }),
      prescription: basePrescription(),
      rules: [rule({ defaultChannel: "email" })],
      now: NOW,
    });
    expect(plan.channel).toBe("voice");
    expect(plan.channelSource).toBe("patient_override");
  });

  it("cadence override and channel override are independent", () => {
    // Patient overrides cadence only; channel should still come from
    // the rule.
    const plan = resolveOutreachPlan({
      patient: basePatient({ cadenceOverrideDays: 7 }),
      prescription: basePrescription(),
      rules: [rule({ defaultChannel: "voice", cadenceDays: 120 })],
      now: NOW,
    });
    expect(plan.cadenceDays).toBe(7);
    expect(plan.cadenceSource).toBe("patient_override");
    expect(plan.channel).toBe("voice");
    expect(plan.channelSource).toBe("rule");
  });
});

describe("resolveOutreachPlan — rule predicates", () => {
  it("matches on SKU prefix", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription({ itemSku: "MASK-FULL-LRG" }),
      rules: [
        rule({
          id: "mask-rule",
          matchItemSkuPrefix: "MASK-",
          cadenceDays: 30,
        }),
      ],
      now: NOW,
    });
    expect(plan.cadenceDays).toBe(30);
    expect(plan.matchedRuleId).toBe("mask-rule");
  });

  it("does not match when SKU prefix differs", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription({ itemSku: "TUBING-STD-6FT" }),
      rules: [rule({ matchItemSkuPrefix: "MASK-", cadenceDays: 30 })],
      now: NOW,
    });
    expect(plan.cadenceSource).toBe("prescription");
    expect(plan.matchedRuleId).toBeNull();
  });

  it("requires recorded payer to match a payer-constrained rule", () => {
    const planNoPayer = resolveOutreachPlan({
      patient: basePatient({ insurancePayer: null }),
      prescription: basePrescription(),
      rules: [rule({ matchInsurancePayer: "Aetna", cadenceDays: 45 })],
      now: NOW,
    });
    expect(planNoPayer.matchedRuleId).toBeNull();
    expect(planNoPayer.cadenceSource).toBe("prescription");

    const planWithPayer = resolveOutreachPlan({
      patient: basePatient({ insurancePayer: "Aetna" }),
      prescription: basePrescription(),
      rules: [rule({ matchInsurancePayer: "Aetna", cadenceDays: 45 })],
      now: NOW,
    });
    expect(planWithPayer.cadenceDays).toBe(45);
  });

  it("respects min/max tenure bounds (inclusive)", () => {
    // Patient is exactly 30 days tenured.
    const created = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const patient = basePatient({ createdAt: created });

    const inWindow = resolveOutreachPlan({
      patient,
      prescription: basePrescription(),
      rules: [
        rule({ minTenureDays: 30, maxTenureDays: 365, cadenceDays: 75 }),
      ],
      now: NOW,
    });
    expect(inWindow.cadenceDays).toBe(75);

    const tooNew = resolveOutreachPlan({
      patient,
      prescription: basePrescription(),
      rules: [
        rule({ minTenureDays: 31, maxTenureDays: 365, cadenceDays: 75 }),
      ],
      now: NOW,
    });
    expect(tooNew.cadenceSource).toBe("prescription");

    const tooOld = resolveOutreachPlan({
      patient,
      prescription: basePrescription(),
      rules: [
        rule({ minTenureDays: 0, maxTenureDays: 29, cadenceDays: 75 }),
      ],
      now: NOW,
    });
    expect(tooOld.cadenceSource).toBe("prescription");
  });

  it("skips inactive rules even when predicates match", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription(),
      rules: [rule({ active: false, cadenceDays: 30 })],
      now: NOW,
    });
    expect(plan.cadenceSource).toBe("prescription");
  });
});

describe("resolveOutreachPlan — rule ordering", () => {
  it("lower priority is evaluated first", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription(),
      rules: [
        rule({ id: "a", priority: 200, cadenceDays: 200 }),
        rule({ id: "b", priority: 50, cadenceDays: 50 }),
        rule({ id: "c", priority: 100, cadenceDays: 100 }),
      ],
      now: NOW,
    });
    expect(plan.matchedRuleId).toBe("b");
    expect(plan.cadenceDays).toBe(50);
  });

  it("ties broken by createdAt ascending", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient(),
      prescription: basePrescription(),
      rules: [
        rule({
          id: "newer",
          priority: 100,
          createdAt: new Date("2026-04-01T00:00:00Z"),
          cadenceDays: 100,
        }),
        rule({
          id: "older",
          priority: 100,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          cadenceDays: 30,
        }),
      ],
      now: NOW,
    });
    expect(plan.matchedRuleId).toBe("older");
    expect(plan.cadenceDays).toBe(30);
  });
});

describe("resolveOutreachPlan — combined scenarios", () => {
  it("matched rule fills cadence; patient override-only-channel still wins for channel", () => {
    const plan = resolveOutreachPlan({
      patient: basePatient({
        insurancePayer: "Medicare",
        channelPreference: "email",
      }),
      prescription: basePrescription({ itemSku: "MASK-FULL-LRG" }),
      rules: [
        rule({
          id: "medicare-mask",
          matchItemSkuPrefix: "MASK-",
          matchInsurancePayer: "Medicare",
          cadenceDays: 45,
          defaultChannel: "voice",
        }),
      ],
      now: NOW,
    });
    expect(plan).toEqual({
      cadenceDays: 45,
      cadenceSource: "rule",
      channel: "email",
      channelSource: "patient_override",
      matchedRuleId: "medicare-mask",
    });
  });
});
