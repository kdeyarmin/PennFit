import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  shouldAutoEnroll,
  runCoachingAutoEnrollSweep,
  RISK_THRESHOLD,
  EARLY_WINDOW_MIN_DAYS,
  EARLY_WINDOW_MAX_DAYS,
} from "./coaching-auto-enroll";
import type { AdherenceScore } from "./adherence-predictor";

function score(over: Partial<AdherenceScore> = {}): AdherenceScore {
  return {
    probabilityCompliant: 0.2,
    daysOfTherapy: 10,
    factors: [],
    scoredAt: new Date().toISOString(),
    ...over,
  };
}

describe("shouldAutoEnroll", () => {
  it("enrolls an at-risk patient inside the early window", () => {
    expect(shouldAutoEnroll(score({ probabilityCompliant: 0.2 }))).toBe(true);
  });

  it("enrolls exactly at the risk threshold", () => {
    expect(
      shouldAutoEnroll(score({ probabilityCompliant: RISK_THRESHOLD })),
    ).toBe(true);
  });

  it("does not enroll a patient above the risk threshold", () => {
    expect(
      shouldAutoEnroll(score({ probabilityCompliant: RISK_THRESHOLD + 0.05 })),
    ).toBe(false);
  });

  it("does not enroll before the minimum days of therapy", () => {
    expect(
      shouldAutoEnroll(
        score({
          daysOfTherapy: EARLY_WINDOW_MIN_DAYS - 1,
          probabilityCompliant: 0.05,
        }),
      ),
    ).toBe(false);
  });

  it("does not enroll after the early-therapy window has closed", () => {
    expect(
      shouldAutoEnroll(
        score({
          daysOfTherapy: EARLY_WINDOW_MAX_DAYS + 1,
          probabilityCompliant: 0.05,
        }),
      ),
    ).toBe(false);
  });

  it("excludes the no-data case (daysOfTherapy 0)", () => {
    expect(
      shouldAutoEnroll(score({ daysOfTherapy: 0, probabilityCompliant: 0.5 })),
    ).toBe(false);
  });

  it("respects custom thresholds", () => {
    const s = score({ probabilityCompliant: 0.45, daysOfTherapy: 3 });
    expect(shouldAutoEnroll(s)).toBe(false);
    expect(shouldAutoEnroll(s, { riskThreshold: 0.5, minDays: 1 })).toBe(true);
  });
});

describe("runCoachingAutoEnrollSweep", () => {
  beforeEach(() => supabaseMock.reset());

  function isoDaysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  it("enrolls an early-risk patient and suppresses one with an open plan", async () => {
    // 1. Candidate nights → patients A and B (A appears twice → deduped).
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "A" }, { patient_id: "A" }, { patient_id: "B" }],
    });
    // 2. Existing plans → B has an open plan (suppressed); A has none.
    stageSupabaseResponse("patient_coaching_plans", "select", {
      data: [{ patient_id: "B", closed_at: null }],
    });
    // 3. A's therapy nights for the scorer: 7 low-usage nights, first
    //    night 10 days ago → daysOfTherapy 10, week-1 avg 120 min → the
    //    scorer lands ~0.05, well under the 0.30 risk threshold.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: Array.from({ length: 7 }, (_, i) => ({
        usage_minutes: 120,
        leak_rate_l_min: "5",
        night_date: isoDaysAgo(10 - i),
      })),
    });
    // 4. The plan insert succeeds.
    stageSupabaseResponse("patient_coaching_plans", "insert", { data: [{}] });

    const stats = await runCoachingAutoEnrollSweep();
    expect(stats.candidates).toBe(2);
    expect(stats.skippedExistingPlan).toBe(1); // B
    expect(stats.scored).toBe(1); // A
    expect(stats.enrolled).toBe(1); // A
  });

  it("returns early with zero candidates when no recent nights exist", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
    const stats = await runCoachingAutoEnrollSweep();
    expect(stats).toEqual({
      candidates: 0,
      scored: 0,
      enrolled: 0,
      skippedExistingPlan: 0,
    });
  });

  it("scores but does not enroll a compliant early-window patient", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [{ patient_id: "C" }],
    });
    stageSupabaseResponse("patient_coaching_plans", "select", { data: [] });
    // High week-1 usage (420 min) → scorer ~0.9 → not at risk.
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: Array.from({ length: 7 }, (_, i) => ({
        usage_minutes: 420,
        leak_rate_l_min: "5",
        night_date: isoDaysAgo(10 - i),
      })),
    });
    const stats = await runCoachingAutoEnrollSweep();
    expect(stats.scored).toBe(1);
    expect(stats.enrolled).toBe(0);
  });
});
