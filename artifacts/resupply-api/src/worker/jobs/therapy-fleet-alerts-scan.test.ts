// Tests for the therapy-fleet alerts-scan worker job.
//
// Coverage:
//   * Detects worklist reasons + setup at_risk into open alerts; inserts
//     only the not-yet-open ones; auto-resolves stale open alerts.
//   * Flag OFF → never sends a patient SMS.
//   * Flag ON + Twilio configured + explicit SMS opt-in → sends one
//     adherence SMS for a patient-appropriate alert.
//   * Flag ON but no consent row → does not send.

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

import { runTherapyFleetAlertsScan } from "./therapy-fleet-alerts-scan";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  supabaseMock.reset();
  featureEnabled.value = false;
  sendSmsMock.mockClear();
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

describe("runTherapyFleetAlertsScan — internal feed", () => {
  it("inserts newly-detected alerts and auto-resolves stale ones", async () => {
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [
        {
          patient_id: P1,
          reasons: ["compliance_risk", "high_leak"],
          nights_over_4h: "8",
          avg_ahi: "3.0",
          avg_leak_l_min: "30",
          days_since_last_night: "2",
        },
      ],
    });
    stageSupabaseRpcResponse("therapy_setup_adherence_list", {
      data: [
        {
          patient_id: P2,
          status: "at_risk",
          best_30day_count: "3",
          days_remaining: "10",
          nights_needed: "18",
        },
      ],
    });
    // One stale open alert (P3/high_ahi) that is no longer detected.
    stageSupabaseResponse("therapy_fleet_alerts", "select", {
      data: [{ id: "stale-1", patient_id: P3, alert_type: "high_ahi" }],
    });

    const result = await runTherapyFleetAlertsScan();

    expect(result.detected).toBe(3); // P1×2 + P2×1
    expect(result.created).toBe(3);
    expect(result.resolved).toBe(1);
    expect(result.messaged).toBe(0);

    const inserts = getSupabaseWritePayloads("therapy_fleet_alerts", "insert");
    expect(inserts).toHaveLength(1);
    const rows = inserts[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual(
      expect.objectContaining({
        patient_id: P1,
        alert_type: "compliance_risk",
        severity: "high",
        status: "open",
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ alert_type: "high_leak", severity: "medium" }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        patient_id: P2,
        alert_type: "setup_at_risk",
        severity: "high",
      }),
    );

    // The stale open alert is resolved (an update was issued).
    expect(
      getSupabaseWritePayloads("therapy_fleet_alerts", "update").length,
    ).toBeGreaterThanOrEqual(1);

    // Flag off → no SMS.
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it("does not re-insert an already-open alert", async () => {
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [{ patient_id: P1, reasons: ["compliance_risk"] }],
    });
    stageSupabaseRpcResponse("therapy_setup_adherence_list", { data: [] });
    stageSupabaseResponse("therapy_fleet_alerts", "select", {
      data: [{ id: "a1", patient_id: P1, alert_type: "compliance_risk" }],
    });
    const result = await runTherapyFleetAlertsScan();
    expect(result.created).toBe(0);
    expect(result.resolved).toBe(0);
    expect(getSupabaseWritePayloads("therapy_fleet_alerts", "insert")).toEqual(
      [],
    );
  });
});

describe("runTherapyFleetAlertsScan — auto-outreach (flag-gated)", () => {
  function configureTwilio() {
    process.env.TWILIO_ACCOUNT_SID = "AC_test";
    process.env.TWILIO_AUTH_TOKEN = "tok";
    process.env.TWILIO_PHONE_NUMBER = "+15555550100";
    process.env.RAILWAY_PUBLIC_DOMAIN = "pennfit.example.com";
  }

  it("sends one adherence SMS for a consented patient when the flag is on", async () => {
    featureEnabled.value = true;
    configureTwilio();
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [{ patient_id: P1, reasons: ["compliance_risk"] }],
    });
    stageSupabaseRpcResponse("therapy_setup_adherence_list", { data: [] });
    stageSupabaseResponse("therapy_fleet_alerts", "select", { data: [] });
    // worker_dedup_keys insert → default (no error) → cap claim succeeds.
    stageSupabaseResponse("patients", "select", {
      data: { email: "ada@example.com" },
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: { smsTransactional: true } },
    });

    const result = await runTherapyFleetAlertsScan();
    expect(result.messaged).toBe(1);
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const arg = sendSmsMock.mock.calls[0]?.[0];
    expect(arg?.patientId).toBe(P1);
    expect(arg?.body).toContain("CPAP");
    // The frequency-cap key is claimed once a message actually goes out.
    expect(
      getSupabaseWritePayloads("worker_dedup_keys", "insert"),
    ).toHaveLength(1);
  });

  it("does not send when the patient has no SMS opt-in", async () => {
    featureEnabled.value = true;
    configureTwilio();
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [{ patient_id: P1, reasons: ["compliance_risk"] }],
    });
    stageSupabaseRpcResponse("therapy_setup_adherence_list", { data: [] });
    stageSupabaseResponse("therapy_fleet_alerts", "select", { data: [] });
    stageSupabaseResponse("patients", "select", {
      data: { email: "ada@example.com" },
    });
    // No shop_customers row → defaults (smsTransactional=false) → skip.
    stageSupabaseResponse("shop_customers", "select", { data: null });

    const result = await runTherapyFleetAlertsScan();
    expect(result.messaged).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
    // Regression guard: the 14-day cap key must NOT be claimed for a
    // patient who was skipped (no opt-in / DND), otherwise a patient who
    // is merely ineligible at the instant of this fixed-time nightly scan
    // would be suppressed for the full cooldown and never re-evaluated.
    expect(getSupabaseWritePayloads("worker_dedup_keys", "insert")).toEqual([]);
  });

  it("does not send a patient SMS for clinical-only alert types", async () => {
    featureEnabled.value = true;
    configureTwilio();
    // high_ahi / high_leak are internal-only — not patient-messageable.
    stageSupabaseRpcResponse("therapy_fleet_worklist", {
      data: [{ patient_id: P1, reasons: ["high_ahi", "high_leak"] }],
    });
    stageSupabaseRpcResponse("therapy_setup_adherence_list", { data: [] });
    stageSupabaseResponse("therapy_fleet_alerts", "select", { data: [] });

    const result = await runTherapyFleetAlertsScan();
    expect(result.created).toBe(2);
    expect(result.messaged).toBe(0);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});
