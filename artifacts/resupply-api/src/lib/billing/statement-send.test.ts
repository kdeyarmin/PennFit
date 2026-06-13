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
  markStatementsMailed,
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
  // The pending/failed → 'sending' claim UPDATE that gates every
  // electronic dispatch. data [{id}] = claim won; data [] = another
  // sender (batch vs operator click) got there first.
  function stageClaim(won = true) {
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: won ? [{ id: "stmt-1" }] : [],
      error: null,
    });
  }

  it("sends via the chosen channel and records the outcome", async () => {
    stageStatement();
    stagePatient();
    stageCustomerPrefs({}); // defaults → email allowed
    stageClaim();
    // persistOutcome's conditional sending → sent transition.
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: [{ id: "stmt-1" }],
      error: null,
    });

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

    // The claim ran before the send, flipped the row to 'sending', and
    // was conditional on the claimable states only.
    const claimPayload = supabaseMock.writePayloads(
      "patient_billing_statements",
      "update",
    )[0] as Record<string, unknown>;
    expect(claimPayload).toEqual({ delivery_status: "sending" });
    const claimFilters = supabaseMock.filterCalls(
      "patient_billing_statements",
      "update",
    );
    expect(claimFilters).toContainEqual({
      verb: "in",
      args: ["delivery_status", ["pending", "failed"]],
    });
  });

  it("does NOT send when another sender already claimed the row", async () => {
    stageStatement();
    stagePatient();
    stageCustomerPrefs({});
    stageClaim(false); // zero rows back — the concurrent sender won

    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg(), now: new Date("2026-06-01T17:00:00Z") },
    );

    expect(outcome).toEqual({
      kind: "skipped",
      reason: "already_claimed_or_sent",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("throws (does not send) when the claim UPDATE itself errors", async () => {
    stageStatement();
    stagePatient();
    stageCustomerPrefs({});
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: null,
      error: { message: "connection failure" },
    });

    const send = vi.fn<SendFn>();
    await expect(
      sendOneStatement(getSupabaseServiceRoleClient(), "stmt-1", {
        send,
        cfg: stubCfg(),
        now: new Date("2026-06-01T17:00:00Z"),
      }),
    ).rejects.toMatchObject({ message: "connection failure" });
    expect(send).not.toHaveBeenCalled();
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

  it("skips an unrendered statement without sending", async () => {
    stageStatement({ statement_pdf_object_key: null });
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: [{ id: "stmt-1" }],
      error: null,
    });
    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg() },
    );
    expect(outcome).toEqual({
      kind: "skipped",
      reason: "statement_pdf_missing",
    });
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

  it("fails without sending when a rendered statement link cannot be signed", async () => {
    stageStatement();
    stagePatient();
    stageCustomerPrefs({});
    stageClaim();
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: [{ id: "stmt-1" }],
      error: null,
    });

    const send = vi.fn<SendFn>();
    const signPdfUrl = vi.fn().mockResolvedValue(null);
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      {
        send,
        signPdfUrl,
        cfg: stubCfg(),
        now: new Date("2026-06-01T17:00:00Z"),
      },
    );

    expect(outcome).toEqual({
      kind: "failed",
      channel: "email",
      reason: "statement_pdf_link_unavailable",
    });
    expect(signPdfUrl).toHaveBeenCalledWith("statements/stmt-1.pdf");
    expect(send).not.toHaveBeenCalled();
  });

  it("routes a mailed-preference statement to the mail worklist without sending", async () => {
    // delivery_method 'mail' → segregated to print/mail; never emailed.
    stageStatement({ delivery_method: "mail" });
    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg() },
    );
    expect(outcome).toEqual({ kind: "mail", reason: "mail_preference" });
    expect(send).not.toHaveBeenCalled();
  });

  it("emails an emailed-preference statement on the forced email channel", async () => {
    // delivery_method 'email' is an explicit opt-in — sends email without
    // consulting the generic opt-out / DND (no shop_customers read).
    stageStatement({ delivery_method: "email" });
    stagePatient({ phone_e164: "+15551234567" });
    stageClaim();
    const send = vi
      .fn<SendFn>()
      .mockResolvedValue({ kind: "sent", channel: "email" });
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg() },
    );
    expect(outcome).toEqual({ kind: "sent", channel: "email" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toBe("email");
  });

  it("falls back to mail when an emailed-preference patient has no email", async () => {
    stageStatement({ delivery_method: "email" });
    stagePatient({ email: null });
    const send = vi.fn<SendFn>();
    const outcome = await sendOneStatement(
      getSupabaseServiceRoleClient(),
      "stmt-1",
      { send, cfg: stubCfg() },
    );
    expect(outcome).toEqual({
      kind: "mail",
      reason: "no_email_fallback_mail",
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("markStatementsMailed", () => {
  it("flips the guarded rows and returns the marked count", async () => {
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: [{ id: "stmt-1" }, { id: "stmt-2" }],
      error: null,
    });
    const marked = await markStatementsMailed(getSupabaseServiceRoleClient(), [
      "stmt-1",
      "stmt-2",
      "stmt-3",
    ]);
    expect(marked).toBe(2);
  });

  it("is a no-op for an empty id list", async () => {
    const marked = await markStatementsMailed(
      getSupabaseServiceRoleClient(),
      [],
    );
    expect(marked).toBe(0);
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
        statement_pdf_object_key: "statements/stmt-1.pdf",
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
    // The per-statement 'sending' claim.
    stageSupabaseResponse("patient_billing_statements", "update", {
      data: [{ id: "stmt-1" }],
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
