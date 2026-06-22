import { describe, expect, it } from "vitest";

import {
  DELIBERATELY_OFF_FLAGS,
  PLAN_FEATURE_FLAG_PRESETS,
  resolvePlanFlagPreset,
} from "./feature-flag-presets";

describe("plan feature-flag presets", () => {
  it("is cumulative: launch ⊆ growth ⊆ scale", () => {
    const launch = new Set(PLAN_FEATURE_FLAG_PRESETS.launch);
    const growth = new Set(PLAN_FEATURE_FLAG_PRESETS.growth);
    const scale = new Set(PLAN_FEATURE_FLAG_PRESETS.scale);

    for (const k of launch) expect(growth.has(k)).toBe(true);
    for (const k of growth) expect(scale.has(k)).toBe(true);
    expect(growth.size).toBeGreaterThan(launch.size);
    expect(scale.size).toBeGreaterThan(growth.size);
  });

  it("enterprise enables everything scale does", () => {
    expect(new Set(PLAN_FEATURE_FLAG_PRESETS.enterprise)).toEqual(
      new Set(PLAN_FEATURE_FLAG_PRESETS.scale),
    );
  });

  it("mask_fitter is a minimal bundle, not a superset of launch", () => {
    const maskFitter = new Set(PLAN_FEATURE_FLAG_PRESETS.mask_fitter);
    const launch = new Set(PLAN_FEATURE_FLAG_PRESETS.launch);
    expect(maskFitter.size).toBeLessThan(launch.size);
    // It still sends fitting links + has the fitter dispatchers.
    expect(maskFitter.has("sms.reminders")).toBe(true);
    expect(maskFitter.has("fitter_supply_campaign.dispatcher")).toBe(true);
    // …but not full storefront/billing automation.
    expect(maskFitter.has("storefront.checkout")).toBe(false);
    expect(maskFitter.has("billing.auto_submit_claims")).toBe(false);
  });

  it("never auto-enables a deliberately-off flag in any preset", () => {
    for (const [code, keys] of Object.entries(PLAN_FEATURE_FLAG_PRESETS)) {
      const set = new Set(keys);
      for (const off of DELIBERATELY_OFF_FLAGS) {
        expect(set.has(off), `${code} must not enable ${off}`).toBe(false);
      }
    }
  });

  it("has no duplicate keys within a preset", () => {
    for (const [code, keys] of Object.entries(PLAN_FEATURE_FLAG_PRESETS)) {
      expect(new Set(keys).size, `${code} has duplicates`).toBe(keys.length);
    }
  });

  describe("resolvePlanFlagPreset", () => {
    it("returns a lookup Set for a known plan", () => {
      const set = resolvePlanFlagPreset("growth");
      expect(set?.has("bulk_campaigns.send")).toBe(true);
    });

    it("returns null for unknown / empty plan codes (caller keeps legacy copy)", () => {
      expect(resolvePlanFlagPreset(null)).toBeNull();
      expect(resolvePlanFlagPreset(undefined)).toBeNull();
      expect(resolvePlanFlagPreset("")).toBeNull();
      expect(resolvePlanFlagPreset("nonexistent_plan")).toBeNull();
    });
  });
});
