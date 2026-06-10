// Tests for the rx-renewal dispatcher's consent + TCPA-window gating
// (app-review 2026-06-10, P1-3/P1-4). The dispatcher used to select
// patients with NO status filter — texting/emailing patients who had
// texted STOP (status='paused') — and had no quiet-hours gate at all
// on a cron that fired at ~midnight ET.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendSmsMock = vi.fn(async () => ({ sid: "SM1" }));
vi.mock("@workspace/resupply-telecom", async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    createTwilioSmsClient: () => ({ sendSms: sendSmsMock }),
  };
});
vi.mock("../web-push", () => ({
  sendPushToCustomerByEmail: vi.fn(async () => {}),
}));

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
void getSupabaseServiceRoleClient; // mock registration ordering

import { runRxRenewalSendDue } from "./dispatcher";

const ACTOR = {
  adminEmail: "system:test",
  adminUserId: null,
  ip: null,
  userAgent: null,
};

function stageOneDueRx(patientOver: Record<string, unknown> = {}) {
  stageSupabaseResponse("prescriptions", "select", {
    data: [
      {
        id: "rx-1",
        patient_id: "pat-1",
        valid_until: "2026-06-20",
      },
    ],
    error: null,
  });
  stageSupabaseResponse("patients", "select", {
    data: [
      {
        id: "pat-1",
        legal_first_name: "Jane",
        email: "jane@example.com",
        phone_e164: "+15551230000",
        timezone: null,
        address: { zip: "15201" },
        ...patientOver,
      },
    ],
    error: null,
  });
}

beforeEach(() => {
  supabaseMock.reset();
  sendSmsMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runRxRenewalSendDue — consent + send-window gating", () => {
  it("only resolves ACTIVE patients (STOP'd/paused are never contacted)", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-10T17:00:00Z"), // 1pm ET — inside window
      toFake: ["Date"],
    });
    stageOneDueRx();
    // Pre-vendor claim on the prescription row.
    stageSupabaseResponse("prescriptions", "update", {
      data: { id: "rx-1" },
      error: null,
    });

    const outcome = await runRxRenewalSendDue("sms", ACTOR);

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.sent).toBe(1);
    }
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // The patient resolve carries the status filter — a paused (STOP)
    // patient drops out of the map and is never claimed or contacted.
    expect(supabaseMock.filterCalls("patients", "select")).toContainEqual({
      verb: "eq",
      args: ["status", "active"],
    });
  });

  it("defers SMS outside the 9am–8pm patient-local window without claiming", async () => {
    vi.useFakeTimers({
      now: new Date("2026-06-10T04:43:00Z"), // the old cron slot — ~midnight ET
      toFake: ["Date"],
    });
    stageOneDueRx();

    const outcome = await runRxRenewalSendDue("sms", ACTOR);

    expect(sendSmsMock).not.toHaveBeenCalled();
    // Not claimed → the next in-window run picks the row up.
    expect(supabaseMock.callCount("prescriptions", "update")).toBe(0);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.skippedQuietHours).toBe(1);
      expect(outcome.sent).toBe(0);
    }
  });

  it("evaluates the window in the PATIENT's timezone", async () => {
    // 14:00 UTC = 10am ET (inside) but 7am PT (outside).
    vi.useFakeTimers({
      now: new Date("2026-06-10T14:00:00Z"),
      toFake: ["Date"],
    });
    stageOneDueRx({ timezone: "America/Los_Angeles" });

    const outcome = await runRxRenewalSendDue("sms", ACTOR);

    expect(sendSmsMock).not.toHaveBeenCalled();
    if (outcome.status === "ok") {
      expect(outcome.skippedQuietHours).toBe(1);
    }
  });
});
