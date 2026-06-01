// Tests for Biller #30 — statement send. Pure channel gating +
// sendOne/runBatch with an injected sender (no real SendGrid/Twilio) and
// staged supabase.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { DEFAULT_COMMUNICATION_PREFERENCES } from "@workspace/resupply-db";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  pickStatementChannel,
  sendOneStatement,
  runStatementBatchSend,
  type SendOutcome,
  type StatementChannel,
  type StatementContext,
  type StatementMessagingConfig,
} from "./statement-send";

type SendFn = (
  ctx: StatementContext,
  channel: StatementChannel,
  cfg: StatementMessagingConfig,
) => Promise<SendOutcome>;

beforeEach(() => {
  supabaseMock.reset();
});

const prefs = (over: Record<string, unknown> = {}) => ({
  ...DEFAULT_COMMUNICATION_PREFERENCES,
  ...over,
});

describe("pickStatementChannel (pure)", () => {
  const noon = new Date("2026-06-01T17:00:00Z"); // 1pm ET — outside any DND

  it("defaults to email (billingStatement on, transactional sms off)", () => {
    const got = pickStatementChannel(
      prefs(),
      { hasEmail: true, hasPhone: true },
      noon,
    );
    expect(got.channel).toBe("email");
  });

  it("uses SMS when the patient opted into transactional SMS and prefers it", () => {
    const got = pickStatementChannel(
      prefs({ smsTransactional: true, preferredChannel: "sms" }),
      { hasEmail: true, hasPhone: true },
      noon,
    );
    expect(got.channel).toBe("sms");
  });

  it("falls back to the other consented channel when the preferred has no contact", () => {
    const got = pickStatementChannel(
      prefs({ smsTransactional: true, preferredChannel: "sms" }),
      { hasEmail: true, hasPhone: false }, // no phone → fall back to email
      noon,
    );
    expect(got.channel).toBe("email");
  });

  it("skips with opted_out_or_dnd when the only channel is opted out", () => {
    const got = pickStatementChannel(
      prefs({ emailBillingStatements: false }),
      { hasEmail: true, hasPhone: false },
      noon,
    );
    expect(got).toEqual({ channel: null, reason: "opted_out_or_dnd" });
  });

  it("skips with no_contact_channels when there is no contact at all", () => {
    const got = pickStatementChannel(
      prefs(),
      { hasEmail: false, hasPhone: false },
      noon,
    );
    expect(got).toEqual({ channel: null, reason: "no_contact_channels" });
  });

  it("respects the DND window (email blocked at a quiet hour)", () => {
    // DND 0..23 local everywhere; with an explicit timezone, any hour is quiet.
    const got = pickStatementChannel(
      prefs({ dndStartHour: 0, dndEndHour: 23, timezone: "America/New_York" }),
      { hasEmail: true, hasPhone: false },
      new Date("2026-06-01T10:00:00Z"), // 6am ET — inside 0..23
    );
    expect(got.channel).toBeNull();
  });
});

describe("sendOneStatement", () => {
  function stageStatement(over: Record<string, unknown> = {}) {
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: {
        id: "stmt-1",
        patient_id: "pat-1",
        total_patient_responsibility_cents: 5000,
        statement_pdf_object_key: "statements/stmt-1.pdf",
        delivery_status: "pending",
        ...over,
      },
      error: null,
    });
  }
  function stagePatient(over: Record<string, unknown> = {}) {
    stageSupabaseResponse("patients", "select", {
      data: {
        email: "p@example.com",
        phone_e164: null,
        address: { zip: "15201" },
        ...over,
      },
      error: null,
    });
  }
  function stageCustomerPrefs(communication_preferences: unknown) {
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences },
      error: null,
    });
  }

  it("sends via the chosen channel and records the outcome", async () => {
    stageStatement();
    stagePatient();
    stageCustomerPrefs({}); // defaults → email allowed

    const send = vi
      .fn<SendFn>()
      .mockResolvedValue({ kind: "sent", channel: "email" });

    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg(), now: new Date("2026-06-01T17:00:00Z") },
    );

    expect(outcome).toEqual({ kind: "sent", channel: "email" });
    expect(send).toHaveBeenCalledTimes(1);
    const [ctx, channel] = send.mock.calls[0]!;
    expect(channel).toBe("email");
    expect(ctx.amountCents).toBe(5000);
  });

  it("skips a zero-balance statement without sending", async () => {
    stageStatement({ total_patient_responsibility_cents: 0 });
    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg() },
    );
    expect(outcome).toEqual({ kind: "skipped", reason: "zero_balance" });
    expect(send).not.toHaveBeenCalled();
  });

  it("skips (no send) when the patient opted out of the only channel", async () => {
    stageStatement();
    stagePatient({ phone_e164: null });
    stageCustomerPrefs({ emailBillingStatements: false });
    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg(), now: new Date("2026-06-01T17:00:00Z") },
    );
    expect(outcome.kind).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runStatementBatchSend", () => {
  it("sends each pending statement and summarizes", async () => {
    // pending-list select (array), then sendOneStatement's per-statement reads
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: [{ id: "stmt-1", total_patient_responsibility_cents: 5000 }],
      error: null,
    });
    stageSupabaseResponse("patient_billing_statements", "select", {
      data: {
        id: "stmt-1",
        patient_id: "pat-1",
        total_patient_responsibility_cents: 5000,
        statement_pdf_object_key: null,
        delivery_status: "pending",
      },
      error: null,
    });
    stageSupabaseResponse("patients", "select", {
      data: { email: "p@example.com", phone_e164: null, address: null },
      error: null,
    });
    stageSupabaseResponse("shop_customers", "select", {
      data: { communication_preferences: {} },
      error: null,
    });

    const send = vi
      .fn<SendFn>()
      .mockResolvedValue({ kind: "sent", channel: "email" });

    const result = await runStatementBatchSend(
      { cap: 50 },
      { send, cfg: stubCfg(), now: new Date("2026-06-01T17:00:00Z") },
    );

    expect(result.scanned).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

function stubCfg() {
  return {
    sendgridApiKey: "SG.x",
    sendgridFromEmail: "info@pennpaps.com",
    sendgridFromName: "PennPaps",
    twilioAccountSid: null,
    twilioAuthToken: null,
    twilioPhoneNumber: null,
    twilioMessagingServiceSid: null,
    practiceName: "PennPaps",
  };
}
