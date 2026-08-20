// Drift guard: the plan presets live in the pure @workspace/resupply-domain
// package (so the tenant:onboard script can import them without pulling in
// the API), but the canonical list of flag keys lives HERE in
// FEATURE_FLAG_KEYS. This test bridges the two: every key referenced by a
// preset must be a real flag, and every real flag must be accounted for
// (enabled by some plan OR on the deliberately-off list) — so a newly-added
// flag can't silently default to "off for every tenant" without a decision.
import {
  DELIBERATELY_OFF_FLAGS,
  isPresetExemptFlag,
  PLAN_FEATURE_FLAG_PRESETS,
  PRESET_EXEMPT_FLAG_KEYS,
} from "@workspace/resupply-domain";
import { describe, expect, it } from "vitest";

import { FEATURE_FLAG_KEYS } from "./feature-flags";

const CANONICAL = new Set<string>(FEATURE_FLAG_KEYS);

describe("plan presets vs FEATURE_FLAG_KEYS", () => {
  it("only references real flag keys", () => {
    const referenced = new Set<string>([
      ...DELIBERATELY_OFF_FLAGS,
      ...Object.values(PLAN_FEATURE_FLAG_PRESETS).flat(),
    ]);
    const unknown = [...referenced].filter((k) => !CANONICAL.has(k));
    expect(
      unknown,
      `preset references unknown flag(s): ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("accounts for every catalog flag (some plan enables it, or it's deliberately off)", () => {
    const accounted = new Set<string>([
      ...DELIBERATELY_OFF_FLAGS,
      ...Object.values(PLAN_FEATURE_FLAG_PRESETS).flat(),
    ]);
    const orphaned = FEATURE_FLAG_KEYS.filter(
      (k) => !accounted.has(k) && !isPresetExemptFlag(k),
    );
    expect(
      orphaned,
      `flag(s) not assigned to any plan and not on DELIBERATELY_OFF: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps preset-exempt flags out of every plan bundle", () => {
    // A preset turns OFF everything it does not list, so a `module.*` key
    // that leaked into a bundle would flip a tenant's navigation choices
    // on plan change — and one that leaked into SOME bundles but not
    // others would flip them on upgrade. Neither belongs to a plan.
    const listed = new Set<string>([
      ...DELIBERATELY_OFF_FLAGS,
      ...Object.values(PLAN_FEATURE_FLAG_PRESETS).flat(),
    ]);
    const leaked = [...listed].filter((k) => isPresetExemptFlag(k));
    expect(
      leaked,
      `preset-exempt flag(s) referenced by a plan preset: ${leaked.join(", ")}`,
    ).toEqual([]);
  });

  it("actually exempts the app-module family (guards the prefix itself)", () => {
    // Belt and braces: if the prefix list ever drifted from the key
    // naming, the two tests above would both pass vacuously.
    const modules = FEATURE_FLAG_KEYS.filter((k) => k.startsWith("module."));
    expect(modules.length).toBeGreaterThan(5);
    for (const k of modules) expect(isPresetExemptFlag(k)).toBe(true);
    // And nothing outside the family is swept up, except the explicitly
    // enumerated exact-match exemptions.
    const exactExempt = new Set<string>(PRESET_EXEMPT_FLAG_KEYS);
    for (const k of FEATURE_FLAG_KEYS.filter(
      (k) => !k.startsWith("module.") && !exactExempt.has(k),
    )) {
      expect(isPresetExemptFlag(k), k).toBe(false);
    }
  });

  it("exempts the platform's own sales-line flag from every bundle", () => {
    // `voice.breathe_sales` gates CareMetric's inbound sales line, which
    // reads the SEED tenant's row (isFeatureEnabled with no orgId). A
    // preset turns OFF everything it does not list, so if this key were
    // preset-governed, applying a plan bundle to the seed tenant would
    // silently take the platform's own sales line down. It must be exempt
    // in BOTH directions — not merely absent from the bundles.
    expect(PRESET_EXEMPT_FLAG_KEYS).toContain("voice.breathe_sales");
    expect(isPresetExemptFlag("voice.breathe_sales")).toBe(true);
    expect(CANONICAL.has("voice.breathe_sales")).toBe(true);
  });
});
