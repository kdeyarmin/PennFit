import { describe, it, expect } from "vitest";

import {
  DECISIONED_CLAIM_STATUSES,
  DENIAL_CLAIM_STATUSES,
  DENIAL_RATE_WINDOW_DAYS,
  denialRateWindowCutoffIso,
  isDenialStatus,
} from "./denial-rate";

describe("denial-rate canonical definitions", () => {
  it("counts denied and appealed as denials, nothing else", () => {
    expect(isDenialStatus("denied")).toBe(true);
    expect(isDenialStatus("appealed")).toBe(true);
    expect(isDenialStatus("paid")).toBe(false);
    expect(isDenialStatus("closed")).toBe(false);
    expect(isDenialStatus("submitted")).toBe(false);
  });

  it("decisioned denominator = paid/denied/closed/appealed; denial numerator ⊆ it", () => {
    expect([...DECISIONED_CLAIM_STATUSES].sort()).toEqual([
      "appealed",
      "closed",
      "denied",
      "paid",
    ]);
    for (const s of DENIAL_CLAIM_STATUSES) {
      expect(DECISIONED_CLAIM_STATUSES).toContain(s);
    }
  });

  it("window cutoff is 90 days before the supplied now", () => {
    expect(DENIAL_RATE_WINDOW_DAYS).toBe(90);
    const now = Date.UTC(2026, 5, 21, 0, 0, 0); // 2026-06-21
    const cutoff = denialRateWindowCutoffIso(now);
    // 90 days earlier → 2026-03-23.
    expect(cutoff).toBe(new Date(now - 90 * 86_400_000).toISOString());
    expect(cutoff.startsWith("2026-03-23")).toBe(true);
  });
});
