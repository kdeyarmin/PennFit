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
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// The sweep now fans out per active tenant and gates each on the
// `fitter_first_day_nudge.dispatcher` flag; force it on so the per-org body
// runs (the send pipeline itself is exercised elsewhere).
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => true),
}));

// Pin tenant link base so eligibility/send tests do not skip on a
// missing custom-domain row in the synthetic org fixture.
vi.mock("../../lib/tenant-branding", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/tenant-branding")>();
  return {
    ...actual,
    resolveTenantLinkBaseUrl: vi.fn(
      async (_orgId: string, platformFallback: string) =>
        platformFallback.replace(/\/$/, ""),
    ),
  };
});

import {
  composeFirstDayEmail,
  composeFirstDaySms,
  runFirstDayNudgeSweep,
} from "./fitter-lead-first-day-nudge";

beforeEach(() => {
  supabaseMock.reset();
  vi.unstubAllEnvs();
  // Fan-out reads `organizations`; stage a single active org so the
  // per-tenant cases behave as the prior one-tenant sweep.
  stageSupabaseResponse("organizations", "select", {
    data: [{ id: "00000000-0000-4000-8000-000000000001" }],
  });
});

describe("composeFirstDayEmail", () => {
  it("tailors the opening line to the lead source", () => {
    const fit = composeFirstDayEmail({
      practiceName: "Penn Home Medical Supply",
      resumeUrl: "https://x/consent",
      source: "consent",
    });
    expect(fit.text).toContain("the at-home mask fitting");

    const quiz = composeFirstDayEmail({
      practiceName: "Penn Home Medical Supply",
      resumeUrl: "https://x/consent",
      source: "sleep_apnea_quiz",
    });
    expect(quiz.text).toContain("the sleep-apnea quiz");

    const ins = composeFirstDayEmail({
      practiceName: "Penn Home Medical Supply",
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
  it("stays under 160 characters and includes STOP", () => {
    const sms = composeFirstDaySms({
      practiceName: "Penn Home Medical Supply",
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

  it("excludes unsubscribed leads even when marketing_opt_in is still true", async () => {
    // The admin force-unsubscribe and the signed unsubscribe link both
    // stamp unsubscribed_at WITHOUT flipping marketing_opt_in (the
    // original consent record stays intact). The nudge must honour the
    // stop request, not the stale opt-in.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    await runFirstDayNudgeSweep();
    const filters = getSupabaseFilterCalls("fitter_leads", "select");
    expect(filters).toContainEqual({
      verb: "is",
      args: ["unsubscribed_at", null],
    });
  });

  it("scans each active tenant's leads (multi-tenant fan-out)", async () => {
    supabaseMock.reset();
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Each tenant's lead scan comes back empty → nothing sent.
    stageSupabaseResponse("fitter_leads", "select", { data: [] });
    stageSupabaseResponse("fitter_leads", "select", { data: [] });

    const stats = await runFirstDayNudgeSweep();
    expect(stats.scanned).toBe(0);
    expect(stats.emailed).toBe(0);
    // Each active tenant ran its own lead scan.
    expect(getSupabaseCallCount("fitter_leads", "select")).toBe(2);
  });
});
