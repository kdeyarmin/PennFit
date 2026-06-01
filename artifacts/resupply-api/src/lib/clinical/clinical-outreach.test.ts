// Tests for RT #23 clinical outreach — the pure gating/selection/template
// cores + sendOne/runBatch with injected senders (no real SendGrid/Twilio)
// and staged supabase.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { DEFAULT_COMMUNICATION_PREFERENCES } from "@workspace/resupply-db";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  outreachChannelAllowed,
  pickOutreachChannel,
  buildOutreachMessage,
  selectOutreachTargets,
  runClinicalOutreachBatch,
  type OutreachTarget,
} from "./clinical-outreach";

beforeEach(() => {
  supabaseMock.reset();
});

const prefs = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_COMMUNICATION_PREFERENCES,
  ...over,
});
const noon = new Date("2026-06-01T17:00:00Z");

describe("outreachChannelAllowed (mirrors smart-trigger policy)", () => {
  it("allows when there is no prefs row (never opted out)", () => {
    expect(outreachChannelAllowed(null, "email", noon)).toBe(true);
    expect(outreachChannelAllowed(null, "sms", noon)).toBe(true);
  });

  it("requires the channel marketing opt-in when a prefs row exists", () => {
    expect(
      outreachChannelAllowed(prefs({ emailMarketing: false }), "email", noon),
    ).toBe(false);
    expect(
      outreachChannelAllowed(prefs({ emailMarketing: true }), "email", noon),
    ).toBe(true);
  });

  it("DND always blocks, even with no prefs row", () => {
    const dnd = prefs({
      dndStartHour: 0,
      dndEndHour: 23,
      timezone: "America/New_York",
    });
    expect(
      outreachChannelAllowed(dnd, "email", new Date("2026-06-01T10:00:00Z")),
    ).toBe(false);
  });
});

describe("pickOutreachChannel", () => {
  it("prefers email when allowed", () => {
    expect(
      pickOutreachChannel(
        prefs({ emailMarketing: true, smsMarketing: true }),
        { hasEmail: true, hasPhone: true },
        noon,
      ).channel,
    ).toBe("email");
  });

  it("falls back to SMS when email is opted out", () => {
    expect(
      pickOutreachChannel(
        prefs({ emailMarketing: false, smsMarketing: true }),
        { hasEmail: true, hasPhone: true },
        noon,
      ).channel,
    ).toBe("sms");
  });

  it("skips with a reason when everything is opted out", () => {
    expect(
      pickOutreachChannel(
        prefs({ emailMarketing: false, smsMarketing: false }),
        { hasEmail: true, hasPhone: true },
        noon,
      ),
    ).toEqual({ channel: null, reason: "opted_out_or_dnd" });
  });
});

describe("buildOutreachMessage", () => {
  it("uses a category-specific body, falls back to 'other'", () => {
    const leak = buildOutreachMessage("mask_leak", "PennPaps");
    expect(leak.body.toLowerCase()).toContain("leak");
    expect(leak.subject).toContain("PennPaps");
    const unknown = buildOutreachMessage("not_a_category", "PennPaps");
    expect(unknown.body).toBe(buildOutreachMessage("other", "PennPaps").body);
    const nul = buildOutreachMessage(null, "PennPaps");
    expect(nul.body).toBe(buildOutreachMessage("other", "PennPaps").body);
  });
});

describe("selectOutreachTargets", () => {
  const open: OutreachTarget[] = [
    {
      patientId: "p1",
      interventionEncounterId: "e1",
      assessmentCategory: "mask_leak",
    },
    {
      patientId: "p1",
      interventionEncounterId: "e2",
      assessmentCategory: "motivation",
    },
    {
      patientId: "p2",
      interventionEncounterId: "e3",
      assessmentCategory: "congestion",
    },
  ];

  it("de-dupes per patient and caps", () => {
    const out = selectOutreachTargets(open, new Map(), {
      cap: 10,
      minHoursBetweenOutreach: 336,
    });
    expect(out.map((t) => t.patientId)).toEqual(["p1", "p2"]); // p1 once
    const capped = selectOutreachTargets(open, new Map(), {
      cap: 1,
      minHoursBetweenOutreach: 336,
    });
    expect(capped).toHaveLength(1);
  });

  it("skips patients contacted within the frequency-cap window", () => {
    const recent = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const out = selectOutreachTargets(open, new Map([["p1", recent]]), {
      cap: 10,
      minHoursBetweenOutreach: 336, // 14 days
    });
    expect(out.map((t) => t.patientId)).toEqual(["p2"]);
  });
});

describe("runClinicalOutreachBatch", () => {
  it("sends to eligible patients and summarizes", async () => {
    // open interventions
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        {
          id: "e1",
          patient_id: "p1",
          assessment_category: "mask_leak",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      error: null,
    });
    // frequency-cap log lookup → none
    stageSupabaseResponse("clinical_outreach_log", "select", {
      data: [],
      error: null,
    });
    // sendOneOutreach: patient → prefs → log insert
    stageSupabaseResponse("patients", "select", {
      data: { email: "p@example.com", phone_e164: null, address: null },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { emailMarketing: true } },
      error: null,
    });
    stageSupabaseResponse("clinical_outreach_log", "insert", {
      data: {},
      error: null,
    });

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await runClinicalOutreachBatch(
      { cap: 10 },
      {
        sendEmail,
        cfg: {
          sendgridApiKey: "SG.x",
          sendgridFromEmail: "info@pennpaps.com",
          sendgridFromName: "PennPaps",
          twilioAccountSid: null,
          twilioAuthToken: null,
          twilioPhoneNumber: null,
          twilioMessagingServiceSid: null,
          practiceName: "PennPaps",
        },
        now: noon,
      },
    );

    expect(result.openInterventions).toBe(1);
    expect(result.selected).toBe(1);
    expect(result.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("returns early when there are no open interventions", async () => {
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [],
      error: null,
    });
    const result = await runClinicalOutreachBatch({}, { now: noon });
    expect(result).toEqual({
      openInterventions: 0,
      selected: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    });
  });
});
