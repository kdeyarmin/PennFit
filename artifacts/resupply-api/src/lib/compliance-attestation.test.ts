// Pure-function tests for the 90-day adherence window finder.
//
// PDF rendering isn't tested here — pdfkit's output is binary and
// well-covered by its own suite. We test the deterministic
// projection/window-search logic that decides whether a patient
// qualifies, on what date, and over which window.

import { describe, it, expect } from "vitest";

import {
  COMPLIANCE_NIGHT_RATIO,
  COMPLIANT_MINUTES_PER_NIGHT,
  WINDOW_DAYS,
  findBestAdherenceWindow,
  type AdherenceNight,
} from "./compliance-attestation";

// ── helpers ─────────────────────────────────────────────────────────

function isoFromAnchor(anchor: string, dayOffset: number): string {
  const [y, m, d] = anchor.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

/**
 * Build 30 consecutive nights starting at `anchor`, where the
 * first `compliantCount` nights have ≥ 4 hours of usage and the
 * remainder have 1 hour (intentionally non-zero so the "average
 * hours on used nights" math gets exercised).
 */
function buildWindow(
  anchor: string,
  compliantCount: number,
): AdherenceNight[] {
  const nights: AdherenceNight[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    nights.push({
      date: isoFromAnchor(anchor, i),
      usageMinutes:
        i < compliantCount ? COMPLIANT_MINUTES_PER_NIGHT + 60 : 60,
    });
  }
  return nights;
}

// ── findBestAdherenceWindow ────────────────────────────────────────

describe("findBestAdherenceWindow", () => {
  const ANCHOR = "2026-01-01";
  const AS_OF = "2026-05-01"; // > 90 days after anchor → horizonComplete

  it("returns null window + horizonComplete=false when no nights", () => {
    const result = findBestAdherenceWindow([], ANCHOR, "2026-01-05");
    expect(result.qualifies).toBe(false);
    expect(result.window).toBeNull();
    expect(result.horizonComplete).toBe(false);
  });

  it("qualifies when exactly 21 of 30 nights are compliant (≥70%)", () => {
    const nights = buildWindow(ANCHOR, 21);
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(true);
    expect(result.window).not.toBeNull();
    expect(result.window?.compliantNights).toBe(21);
    expect(result.window?.ratio).toBe(0.7);
    // First qualifying window is the canonical answer — confirm
    // it starts AT the anchor, not later.
    expect(result.window?.startDate).toBe(ANCHOR);
    expect(result.window?.endDate).toBe(isoFromAnchor(ANCHOR, 29));
  });

  it("does NOT qualify when 20 of 30 nights are compliant (66.7%)", () => {
    const nights = buildWindow(ANCHOR, 20);
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(false);
    // Still returns the best window seen so the admin sees how close.
    expect(result.window).not.toBeNull();
    expect(result.window?.compliantNights).toBe(20);
    expect(result.window?.ratio).toBeCloseTo(20 / 30, 4);
  });

  it("picks the EARLIEST qualifying window, not the best", () => {
    // 21-of-30 starting at day 0 (qualifies), and 30-of-30 starting at
    // day 10 (also qualifies but higher ratio). Auditor convention is
    // "patient qualified on the earliest date the threshold was met."
    const nights: AdherenceNight[] = [];
    for (let i = 0; i < 60; i++) {
      const compliant =
        i < 21 || (i >= 10 && i < 40); // overlap creates both windows
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: compliant ? COMPLIANT_MINUTES_PER_NIGHT : 60,
      });
    }
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(true);
    expect(result.window?.startDate).toBe(ANCHOR);
  });

  it("treats missing dates as non-compliant against the 30-day denominator", () => {
    // 21 compliant nights on days 0-20; days 21-29 have NO data
    // (gap). The earliest 30-day window from anchor covers days
    // 0-29 inclusive — 21 compliant calendar days, 9 missing days
    // counted as 0. That's exactly 21/30 = 0.7, so it qualifies AT
    // the threshold and the compliantNights is 21 (NOT 30 — a
    // missing date is not silently treated as a reported compliant
    // night).
    const nights: AdherenceNight[] = [];
    for (let i = 0; i < 21; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: COMPLIANT_MINUTES_PER_NIGHT,
      });
    }
    // Days 21-29 deliberately left empty (gap inside the window).
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(true);
    expect(result.window?.compliantNights).toBe(21);
    expect(result.window?.ratio).toBe(0.7);
  });

  it("ignores nights outside the 90-day probe horizon", () => {
    // 21 compliant nights starting at day 100 (well past 90). Should
    // not qualify because the qualifying window must fall inside the
    // first 90 days.
    const nights: AdherenceNight[] = [];
    for (let i = 100; i < 121; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: COMPLIANT_MINUTES_PER_NIGHT,
      });
    }
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(false);
  });

  it("does NOT qualify when less than 30 days have elapsed", () => {
    // Patient has 10 days of perfect adherence; asOf is day 11 from
    // anchor. No window can be 30 days long yet.
    const nights: AdherenceNight[] = [];
    for (let i = 0; i < 10; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: COMPLIANT_MINUTES_PER_NIGHT + 60,
      });
    }
    const result = findBestAdherenceWindow(
      nights,
      ANCHOR,
      isoFromAnchor(ANCHOR, 11),
    );
    expect(result.qualifies).toBe(false);
    expect(result.window).toBeNull();
    expect(result.horizonComplete).toBe(false);
  });

  it("flags horizonComplete=true once 90 days have passed", () => {
    const nights = buildWindow(ANCHOR, 0); // 0 compliant, but data exists
    const result = findBestAdherenceWindow(
      nights,
      ANCHOR,
      isoFromAnchor(ANCHOR, 95),
    );
    expect(result.horizonComplete).toBe(true);
    expect(result.qualifies).toBe(false);
  });

  it("computes average usage hours from nights WITH reported data only", () => {
    // 10 nights of 8 hours, 20 missing nights. avg over reported = 8.
    const nights: AdherenceNight[] = [];
    for (let i = 0; i < 10; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: 8 * 60,
      });
    }
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.window?.averageUsageHoursOnUsedNights).toBe(8);
    // 10 of 30 compliant -> doesn't qualify
    expect(result.qualifies).toBe(false);
    expect(result.window?.compliantNights).toBe(10);
  });

  it("treats null usage_minutes as 0 (not as missing)", () => {
    // 21 nights at 240 min and 9 nights at null. Null nights count
    // as 0, so compliantCount = 21 — qualifies.
    const nights: AdherenceNight[] = [];
    for (let i = 0; i < 21; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: COMPLIANT_MINUTES_PER_NIGHT,
      });
    }
    for (let i = 21; i < 30; i++) {
      nights.push({
        date: isoFromAnchor(ANCHOR, i),
        usageMinutes: null,
      });
    }
    const result = findBestAdherenceWindow(nights, ANCHOR, AS_OF);
    expect(result.qualifies).toBe(true);
    expect(result.window?.compliantNights).toBe(21);
  });

  it("rejects malformed anchor / asOf", () => {
    const result = findBestAdherenceWindow(
      [{ date: "2026-01-01", usageMinutes: 300 }],
      "not-a-date",
      "2026-02-01",
    );
    expect(result.qualifies).toBe(false);
    expect(result.window).toBeNull();
  });

  it("threshold ratio exactly matches the documented constant", () => {
    // Sanity: 21/30 = 0.7 exact, which equals COMPLIANCE_NIGHT_RATIO.
    expect(21 / WINDOW_DAYS).toBe(COMPLIANCE_NIGHT_RATIO);
  });
});
