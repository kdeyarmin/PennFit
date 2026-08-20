import { describe, expect, it } from "vitest";

import {
  isUnlimited,
  overageAllowanceFor,
  resolveEffectiveAllowances,
} from "./allowances";

const PLAN = {
  seats: 40,
  activePatients: 10_000,
  fitterFittingsPerMonth: 25,
  outboundMessagesPerMonth: 20_000,
};

describe("resolveEffectiveAllowances", () => {
  it("returns the plan's numbers when there is no override", () => {
    expect(resolveEffectiveAllowances(PLAN, null)).toEqual(PLAN);
    expect(resolveEffectiveAllowances(PLAN, {})).toEqual(PLAN);
  });

  it("lets a custom number override one metric and leaves the rest alone", () => {
    const out = resolveEffectiveAllowances(PLAN, {
      fitterFittingsPerMonth: 5_000,
    });
    expect(out.fitterFittingsPerMonth).toBe(5_000);
    expect(out.seats).toBe(40);
  });

  it("treats an explicit null as unlimited, distinct from zero", () => {
    const out = resolveEffectiveAllowances(PLAN, {
      fitterFittingsPerMonth: null,
      outboundMessagesPerMonth: 0,
    });
    expect(out.fitterFittingsPerMonth).toBeNull();
    expect(isUnlimited(out.fitterFittingsPerMonth)).toBe(true);
    // 0 is "none included" — emphatically NOT unlimited.
    expect(out.outboundMessagesPerMonth).toBe(0);
    expect(isUnlimited(out.outboundMessagesPerMonth)).toBe(false);
  });

  it("surfaces a metric that only the override names", () => {
    const out = resolveEffectiveAllowances(PLAN, { faxEvents: null });
    expect(out.faxEvents).toBeNull();
  });

  it("ignores malformed overrides rather than guessing", () => {
    // A junk override must fall back to the MARKETED number — the failure
    // we can't accept is a typo silently granting unlimited usage.
    const out = resolveEffectiveAllowances(PLAN, {
      seats: "lots",
      activePatients: -1,
      fitterFittingsPerMonth: Number.NaN,
      outboundMessagesPerMonth: { nested: true },
    });
    expect(out).toEqual(PLAN);
  });

  it("normalises fractional values to whole units", () => {
    const out = resolveEffectiveAllowances(
      { seats: 2.9 },
      { activePatients: 10.7 },
    );
    expect(out.seats).toBe(2);
    expect(out.activePatients).toBe(10);
  });

  it("tolerates missing sources entirely", () => {
    expect(resolveEffectiveAllowances(null, null)).toEqual({});
    expect(resolveEffectiveAllowances(undefined, undefined)).toEqual({});
  });
});

describe("overageAllowanceFor", () => {
  it("returns the resolved cap for a known metric", () => {
    const eff = resolveEffectiveAllowances(PLAN, null);
    expect(overageAllowanceFor(eff, "fitterFittingsPerMonth")).toBe(25);
  });

  it("returns null (skip billing) for an unlimited metric", () => {
    const eff = resolveEffectiveAllowances(PLAN, {
      fitterFittingsPerMonth: null,
    });
    expect(overageAllowanceFor(eff, "fitterFittingsPerMonth")).toBeNull();
  });

  it("returns 0 for a metric no source declares", () => {
    // Preserves the pure-metered add-on behaviour (fax_automation,
    // ai_voice_agent): no plan-included amount means billing from unit one.
    const eff = resolveEffectiveAllowances(PLAN, null);
    expect(overageAllowanceFor(eff, "aiVoiceEvents")).toBe(0);
  });

  it("does not confuse a zero allowance with an absent one", () => {
    const eff = resolveEffectiveAllowances({ aiVoiceEvents: 0 }, null);
    expect(overageAllowanceFor(eff, "aiVoiceEvents")).toBe(0);
    expect(isUnlimited(overageAllowanceFor(eff, "aiVoiceEvents"))).toBe(false);
  });
});
