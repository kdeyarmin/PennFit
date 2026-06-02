// Tests for the abandoned-fitter first-day nudge dispatcher.
//
// The full send pipeline (SendGrid + Twilio) is exercised elsewhere;
// these tests pin the pure compose helpers and the eligibility-scan
// predicate that keeps the nudge off patients who already finished
// the fitter (those are owned by the supply campaign).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  composeFirstDayEmail,
  composeFirstDaySms,
  runFirstDayNudgeSweep,
} from "./fitter-lead-first-day-nudge";

beforeEach(() => {
  supabaseMock.reset();
  vi.unstubAllEnvs();
});

describe("composeFirstDayEmail", () => {
  it("tailors the opening line to the lead source", () => {
    const fit = composeFirstDayEmail({
      practiceName: "PennPaps",
      resumeUrl: "https://x/consent",
      source: "consent",
    });
    expect(fit.text).toContain("the at-home mask fitting");

    const quiz = composeFirstDayEmail({
      practiceName: "PennPaps",
      resumeUrl: "https://x/consent",
      source: "sleep_apnea_quiz",
    });
    expect(quiz.text).toContain("the sleep-apnea quiz");

    const ins = composeFirstDayEmail({
      practiceName: "PennPaps",
      resumeUrl: "https://x/consent",
      source: "insurance_quote",
    });
    expect(ins.text).toContain("the insurance estimator");
  });

  it("escapes a user-controlled practice name in the HTML", () => {
    const out = composeFirstDayEmail({
      practiceName: "<script>x</script>",
      resumeUrl: "https://x/consent",
      source: "consent",
    });
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("composeFirstDaySms", () => {
  it("stays a single GSM-7 segment (<=160 chars) and includes STOP", () => {
    const sms = composeFirstDaySms({
      practiceName: "PennPaps",
      resumeUrl: "https://pennfit.example/consent",
    });
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(sms).toContain("Reply STOP to opt out");
  });
});

describe("runFirstDayNudgeSweep — eligibility predicate", () => {
  it("excludes leads that already completed the fitter", async () => {
    // The day-1 nudge says "you didn't quite finish" — a patient who
    // finished the fitter is enrolled in the supply campaign and gets
    // its accurate day-1 touch instead. Assert the scan applies the
    // `completed_at IS NULL` filter (DB-side filtering can't be
    // evaluated by the in-memory mock, so we check the predicate is
    // present).
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    const stats = await runFirstDayNudgeSweep();
    expect(stats.scanned).toBe(0);

    const filters = getSupabaseFilterCalls("fitter_leads", "select");
    expect(filters).toContainEqual({
      verb: "is",
      args: ["completed_at", null],
    });
    // The pre-existing opt-in + unnudged + age predicates remain.
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["marketing_opt_in", true],
    });
    expect(filters).toContainEqual({
      verb: "is",
      args: ["first_day_nudged_at", null],
    });
  });
});
