// Tests for the CPAP setup-deadline outreach worker job.
//
// Coverage:
//   * planDeadlineOutreach tiers (pure): qualified skip, on_track window
//     + tier bodies, at_risk help body.
//   * Flag OFF → counts eligible but sends nothing.
//   * Flag ON + Twilio + opt-in → sends; claims the SHARED alerts-scan
//     cap key (no double-text).
//   * No consent row → no send, no cap claim.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const featureEnabled = vi.hoisted(() => ({ value: false }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => featureEnabled.value),
}));

const sendSmsMock = vi.hoisted(() =>
  vi.fn(async (_input: { patientId: string; body: string }) => ({
    status: "ok" as const,
    conversationId: "c1",
    vendorRef: "SM1",
  })),
);
vi.mock("@workspace/resupply-reminders", () => ({
  sendReminderSms: sendSmsMock,
}));

import {
  planDeadlineOutreach,
  runSetupDeadlineOutreach,
} from "./therapy-setup-deadline-outreach";

const P1 = "11111111-1111-4111-8111-111111111111";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  supabaseMock.reset();
  featureEnabled.value = false;
  sendSmsMock.mockClear();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("planDeadlineOutreach (pure tiers)", () => {
  const base = { patient_id: P1, days_remaining: 30, nights_needed: 5 };

  it("skips qualified patients", () => {
    expect(
      planDeadlineOutreach({ ...base, status: "qualified" }, "PennPaps"),
    ).toBeNull();
  });

  it("skips on_track patients outside the 45-day window", () => {
    expect(
      planDeadlineOutreach(
        { ...base, status: "on_track", days_remaining: 60 },
        "PennPaps",
      ),
    ).toBeNull();
  });

  it("skips on_track patients who need 0 more nights", () => {
    expect(
      planDeadlineOutreach(
        { ...base, status: "on_track", nights_needed: 0 },
        "PennPaps",
      ),
    ).toBeNull();
  });

  it("uses the urgent tier in the final week", () => {
    const body = planDeadlineOutreach(
      { ...base, status: "on_track", days_remaining: 5, nights_needed: 3 },
      "PennPaps",
    );
    expect(body).toContain("almost qualified");
    expect(body).toContain("3 more night(s)");
    expect(body).toContain("5 day(s)");
  });

  it("uses the two-week tier", () => {
    const body = planDeadlineOutreach(
      { ...base, status: "on_track", days_remaining: 12, nights_needed: 4 },
      "PennPaps",
    );
    expect(body).toContain("2 weeks left");
    expect(body).toContain("4 more night(s)");
  });

  it("uses the early check-in tier", () => {
    const body = planDeadlineOutreach(
      { ...base, status: "on_track", days_remaining: 40, nights_needed: 9 },
      "PennPaps",
    );
    expect(body).toContain("Quick check-in");
  });

  it("uses a supportive (no nights-needed) body for at_risk", () => {
    const body = planDeadlineOutreach(
      { ...base, status: "at_risk", nights_needed: 40 },
      "PennPaps",
    );
    expect(body).toContain("back on track");
    expect(body).not.toContain("more night(s)");
  });
});

describe("runSetupDeadlineOutreach", () => {
  function configureTwilio() {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+15555550100";
    process.env.RAILWAY_PUBLIC_DOMAIN = "pennfit.example.com";
  }

  it("counts eligible patients but sends nothing when the flag is off", async () => {
    featureEnabled.value = false;
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          status: "on_track",
          days_remaining: "10",
          nights_needed: "5",
        },
      ],
    });
    const result = await runSetupDeadlineOutreach();
    expect(result.inWindow).toBe(1);
    expect(result.eligible).toBe(1);
    expect(result.messaged).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("sends one deadline SMS for a consented patient and claims the shared cap key", async () => {
    featureEnabled.value = true;
    configureTwilio();
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          status: "on_track",
          days_remaining: "6",
          nights_needed: "3",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: { email: "ada@example.com" },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });

    const result = await runSetupDeadlineOutreach();
    expect(result.messaged).toBe(1);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const arg = sendSmsMock.mock.calls[0]?.[0];
    expect(arg?.patientId).toBe(P1);
    expect(arg?.body).toContain("almost qualified");

    // Shares the alerts-scan cap-key namespace so the two never
    // double-text the same patient.
    const capInserts = getSupabaseWritePayloads("worker_dedup_keys", "insert");
    expect(capInserts).toHaveLength(1);
    expect((capInserts[0] as { key: string }).key).toBe(
      `therapy-alert-sms:${P1}`,
    );
  });

  it("does not send (or claim the cap) without an SMS opt-in", async () => {
    featureEnabled.value = true;
    configureTwilio();
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P1,
          status: "at_risk",
          days_remaining: "8",
          nights_needed: "30",
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: { email: "ada@example.com" },
    });
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const result = await runSetupDeadlineOutreach();
    expect(result.messaged).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(getSupabaseWritePayloads("worker_dedup_keys", "insert")).toEqual([]);
  });
});
