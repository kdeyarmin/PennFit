import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { scorePatientAdherence } from "./adherence-predictor";

const PATIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("scorePatientAdherence", () => {
  beforeEach(() => supabaseMock.reset());

  it("returns null defaults when no therapy nights on file", async () => {
    stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
    const r = await scorePatientAdherence(PATIENT_ID);
    expect(r).not.toBeNull();
    expect(r!.probabilityCompliant).toBe(0.5);
    expect(r!.daysOfTherapy).toBe(0);
  });

  it("scores high when week-1 usage is consistently >= 240 minutes", async () => {
    const baseDate = new Date();
    baseDate.setUTCDate(baseDate.getUTCDate() - 7);
    const nights = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      return {
        usage_minutes: 360,
        leak_rate_l_min: "10",
        night_date: d.toISOString().slice(0, 10),
      };
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: nights });
    const r = await scorePatientAdherence(PATIENT_ID);
    expect(r!.probabilityCompliant).toBeGreaterThan(0.6);
    expect(r!.factors.some((f) => f.key === "week1_usage_high")).toBe(true);
  });

  it("scores low when week-1 usage is < 180 min/night", async () => {
    const baseDate = new Date();
    baseDate.setUTCDate(baseDate.getUTCDate() - 7);
    const nights = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      return {
        usage_minutes: 90,
        leak_rate_l_min: "12",
        night_date: d.toISOString().slice(0, 10),
      };
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: nights });
    const r = await scorePatientAdherence(PATIENT_ID);
    expect(r!.probabilityCompliant).toBeLessThan(0.5);
    expect(r!.factors.some((f) => f.key === "week1_usage_low")).toBe(true);
  });

  it("flags high leak across 3+ nights", async () => {
    const baseDate = new Date();
    baseDate.setUTCDate(baseDate.getUTCDate() - 7);
    const nights = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      return {
        usage_minutes: 360,
        leak_rate_l_min: i < 4 ? "30" : "8",
        night_date: d.toISOString().slice(0, 10),
      };
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: nights });
    const r = await scorePatientAdherence(PATIENT_ID);
    expect(r!.factors.some((f) => f.key === "week1_high_leak")).toBe(true);
  });

  it("scores near 0.9 when the recent 30-day window is already CMS-compliant", async () => {
    const baseDate = new Date();
    baseDate.setUTCDate(baseDate.getUTCDate() - 35);
    const nights = Array.from({ length: 32 }, (_, i) => {
      const d = new Date(baseDate);
      d.setUTCDate(d.getUTCDate() + i);
      return {
        usage_minutes: 360,
        leak_rate_l_min: "10",
        night_date: d.toISOString().slice(0, 10),
      };
    });
    stageSupabaseResponse("patient_therapy_nights", "select", { data: nights });
    const r = await scorePatientAdherence(PATIENT_ID);
    expect(r!.probabilityCompliant).toBeGreaterThanOrEqual(0.9);
    expect(r!.factors.some((f) => f.key === "recent_window_compliant")).toBe(
      true,
    );
  });
});
