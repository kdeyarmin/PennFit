// Drift guard: the plan presets live in the pure @workspace/resupply-domain
// package (so the tenant:onboard script can import them without pulling in
// the API), but the canonical list of flag keys lives HERE in
// FEATURE_FLAG_KEYS. This test bridges the two: every key referenced by a
// preset must be a real flag, and every real flag must be accounted for
// (enabled by some plan OR on the deliberately-off list) — so a newly-added
// flag can't silently default to "off for every tenant" without a decision.
import {
  DELIBERATELY_OFF_FLAGS,
  PLAN_FEATURE_FLAG_PRESETS,
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
    const orphaned = FEATURE_FLAG_KEYS.filter((k) => !accounted.has(k));
    expect(
      orphaned,
      `flag(s) not assigned to any plan and not on DELIBERATELY_OFF: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });
});
