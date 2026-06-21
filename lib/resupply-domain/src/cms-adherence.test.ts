import { describe, expect, it } from "vitest";

import {
  CMS_COMPLIANT_NIGHTS,
  COMPLIANT_MINUTES_PER_NIGHT,
  WINDOW_DAYS,
  findBestAdherenceWindow,
  type AdherenceNight,
} from "./cms-adherence";

// Build `count` consecutive nights starting at `startIso`, each at
// `minutes` of usage.
function nightsFrom(
  startIso: string,
  count: number,
  minutes: number,
): AdherenceNight[] {
  const out: AdherenceNight[] = [];
  const start = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push({ date: d.toISOString().slice(0, 10), usageMinutes: minutes });
  }
  return out;
}

describe("CMS adherence constants", () => {
  it("derives 21 of 30 nights from the ratio (no drift)", () => {
    expect(COMPLIANT_MINUTES_PER_NIGHT).toBe(240);
    expect(WINDOW_DAYS).toBe(30);
    expect(CMS_COMPLIANT_NIGHTS).toBe(21);
  });
});

describe("findBestAdherenceWindow", () => {
  it("qualifies when ≥21 of 30 nights hit 4h, returns the earliest window", () => {
    // 30 nights all compliant, anchored day 1.
    const nights = nightsFrom("2026-01-01", 30, 300);
    const r = findBestAdherenceWindow(nights, "2026-01-01", "2026-05-01");
    expect(r.qualifies).toBe(true);
    expect(r.window?.startDate).toBe("2026-01-01");
    expect(r.window?.compliantNights).toBe(30);
    expect(r.horizonComplete).toBe(true);
  });

  it("does not qualify at 20 of 30 and returns the best window", () => {
    const compliant = nightsFrom("2026-01-01", 20, 300);
    const short = nightsFrom("2026-01-21", 10, 60); // below 4h
    const r = findBestAdherenceWindow(
      [...compliant, ...short],
      "2026-01-01",
      "2026-05-01",
    );
    expect(r.qualifies).toBe(false);
    expect(r.window).not.toBeNull();
    expect(r.window!.compliantNights).toBeLessThan(CMS_COMPLIANT_NIGHTS);
  });

  it("returns no window when there is no usage data", () => {
    const r = findBestAdherenceWindow([], "2026-01-01", "2026-05-01");
    expect(r.qualifies).toBe(false);
    expect(r.window).toBeNull();
  });

  it("returns no window before a full 30 days has elapsed", () => {
    const nights = nightsFrom("2026-01-01", 10, 300);
    const r = findBestAdherenceWindow(nights, "2026-01-01", "2026-01-15");
    expect(r.qualifies).toBe(false);
    expect(r.window).toBeNull();
    expect(r.horizonComplete).toBe(false);
  });

  it("ignores an unparseable anchor date", () => {
    const r = findBestAdherenceWindow(
      nightsFrom("2026-01-01", 30, 300),
      "not-a-date",
      "2026-05-01",
    );
    expect(r.qualifies).toBe(false);
    expect(r.window).toBeNull();
  });
});
