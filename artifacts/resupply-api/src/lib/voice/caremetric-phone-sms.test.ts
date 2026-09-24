import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwilioApiError } from "@workspace/resupply-telecom";
import {
  sendInfoSmsArgs,
  summarizeToolArgsForAudit,
} from "@workspace/resupply-ai";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import {
  buildCareMetricSms,
  readCareMetricSmsConfig,
  sendCareMetricPhoneSms,
  updateCareMetricSmsDelivery,
} from "./caremetric-phone-sms";
import { createVoiceToolDispatcher } from "./tools-impl";

const db = installSupabaseMock();
const args = {
  mobile: "+12125550123",
  resources: ["support", "advisors"] as ("support" | "advisors")[],
  mobile_confirmed: true as const,
  sms_consent: true as const,
};
const deps = {
  orgId: "00000000-0000-4000-8000-000000000000",
  twilioCallSid: `CA${"a".repeat(32)}`,
};
const messageSid = `SM${"b".repeat(32)}`;
const client = { sendSms: vi.fn(), confirmDelivery: vi.fn() };
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  vi.stubEnv("CAREMETRIC_PHONE_SMS_ENABLED", "true");
  vi.stubEnv(
    "CAREMETRIC_PHONE_SMS_MESSAGING_SERVICE_SID",
    `MG${"c".repeat(32)}`,
  );
  vi.stubEnv("TWILIO_ACCOUNT_SID", `AC${"d".repeat(32)}`);
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
  client.sendSms.mockResolvedValue({ messageSid });
  client.confirmDelivery.mockResolvedValue({
    terminal: false,
    delivered: false,
    status: "sent",
    errorCode: null,
  });
});
afterEach(() => vi.unstubAllEnvs());
const send = () => sendCareMetricPhoneSms(args, { ...deps, client });

describe("CareMetric requested texts", () => {
  it("requires an explicit enable flag and dedicated service; never inherits patient routing", async () => {
    vi.stubEnv("CAREMETRIC_PHONE_SMS_MESSAGING_SERVICE_SID", "");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", `MG${"f".repeat(32)}`);
    expect(readCareMetricSmsConfig()).toBeNull();
    expect(await send()).toMatchObject({
      status: "not_sent",
      reason: "texting_unavailable",
    });
    expect(client.sendSms).not.toHaveBeenCalled();
    expect(db.callCount("shared_phone_sms", "insert")).toBe(0);
  });
  it("rejects missing consent, unconfirmed numbers, arbitrary content, invalid resources and oversized bundles", () => {
    for (const patch of [
      { sms_consent: false },
      { mobile_confirmed: false },
      { mobile: "1234" },
      { body: "private message" },
      { resources: ["https://evil.example"] },
      { resources: [] },
      { resources: ["support", "support", "support", "support"] },
    ]) {
      expect(sendInfoSmsArgs.safeParse({ ...args, ...patch }).success).toBe(
        false,
      );
    }
  });
  it("requires a real bound call before sending", async () => {
    expect(
      await sendCareMetricPhoneSms(args, {
        ...deps,
        twilioCallSid: undefined,
        client,
      }),
    ).toMatchObject({ reason: "live_call_required" });
    expect(client.sendSms).not.toHaveBeenCalled();
  });
  it("records consent before submitting and never calls accepted delivery", async () => {
    expect(await send()).toEqual({ ok: true, status: "submitted" });
    const [claim] = db.writePayloads("shared_phone_sms", "insert") as Array<
      Record<string, unknown>
    >;
    expect(claim).toMatchObject({
      recipient: args.mobile,
      twilio_call_sid: deps.twilioCallSid,
      consent_version: "2026-09-24.one-time.v1",
      resources: ["advisors", "support"],
      delivery_status: "submitting",
    });
    expect(claim).not.toHaveProperty("org_id");
    expect(client.sendSms).toHaveBeenCalledOnce();
    expect(client.sendSms).toHaveBeenCalledWith({
      to: args.mobile,
      body: buildCareMetricSms(["advisors", "support"]),
      statusCallbackUrl: `https://cmbreathe.com/resupply-api/sms/caremetric-status?id=${claim.id}`,
    });
  });
  it("fails closed if durable consent cannot be saved", async () => {
    stageSupabaseResponse("shared_phone_sms", "insert", {
      error: { code: "DB_DOWN" },
    });
    expect(await send()).toMatchObject({
      status: "not_sent",
      reason: "request_not_saved",
    });
    expect(client.sendSms).not.toHaveBeenCalled();
  });
  it.each(["accepted", "delivered", "submitting", "unknown", "failed"])(
    "does not resend a persisted %s request after reconnect",
    async (status) => {
      stageSupabaseResponse("shared_phone_sms", "insert", {
        error: { code: "23505" },
      });
      stageSupabaseResponse("shared_phone_sms", "select", {
        data: {
          recipient: args.mobile,
          resources: ["advisors", "support"],
          delivery_status: status,
        },
      });
      expect(await send()).toMatchObject({ already_requested: true });
      expect(client.sendSms).not.toHaveBeenCalled();
    },
  );
  it("refuses a second recipient or another bundle on the same call", async () => {
    stageSupabaseResponse("shared_phone_sms", "insert", {
      error: { code: "23505" },
    });
    stageSupabaseResponse("shared_phone_sms", "select", {
      data: {
        recipient: "+12125550124",
        resources: ["advisors", "support"],
        delivery_status: "accepted",
      },
    });
    expect(await send()).toMatchObject({ reason: "one_followup_per_call" });
    expect(client.sendSms).not.toHaveBeenCalled();
  });
  it("reports delivered only when Twilio confirms delivery", async () => {
    client.confirmDelivery.mockResolvedValue({
      terminal: true,
      delivered: true,
      status: "delivered",
      errorCode: null,
    });
    expect(await send()).toEqual({ ok: true, status: "delivered" });
    expect(db.writePayloads("shared_phone_sms", "update")).toContainEqual(
      expect.objectContaining({ delivery_status: "delivered" }),
    );
  });
  it("reports carrier rejection without claiming delivery", async () => {
    client.confirmDelivery.mockResolvedValue({
      terminal: true,
      delivered: false,
      status: "undelivered",
      errorCode: 30007,
    });
    expect(await send()).toMatchObject({ ok: false, status: "failed" });
  });
  it("respects STOP and never switches senders or retries", async () => {
    client.sendSms.mockRejectedValue(
      new TwilioApiError("opted out", 400, 21610),
    );
    expect(await send()).toMatchObject({
      status: "failed",
      reason: "recipient_opted_out",
    });
    expect(client.sendSms).toHaveBeenCalledOnce();
  });
  it("leaves ambiguous sends unknown rather than retrying", async () => {
    client.sendSms.mockRejectedValue(new Error("socket timed out after POST"));
    expect(await send()).toMatchObject({ ok: false, status: "unknown" });
    expect(client.sendSms).toHaveBeenCalledOnce();
  });
  it("terminal updates cannot regress or attach an unrelated SID", async () => {
    await updateCareMetricSmsDelivery(
      deps.orgId,
      "row-id",
      messageSid,
      "delivered",
      null,
    );
    const filters = db.filterCalls("shared_phone_sms", "update");
    expect(filters).toContainEqual({
      verb: "in",
      args: ["delivery_status", ["submitting", "accepted", "unknown"]],
    });
    expect(filters).toContainEqual({
      verb: "or",
      args: [`twilio_message_sid.is.null,twilio_message_sid.eq.${messageSid}`],
    });
    expect(filters).toContainEqual({ verb: "eq", args: ["id", "row-id"] });
  });
  it("redacts phone numbers from tool audit metadata", () => {
    const audit = summarizeToolArgsForAudit("send_info_sms", args);
    expect(JSON.stringify(audit)).not.toContain(args.mobile);
    expect(audit).toMatchObject({ sms_consent: true, mobile_confirmed: true });
  });
  it.each(["patient", "shop_customer"] as const)(
    "never dispatches a business text on the %s line",
    async (callerKind) => {
      const sender = vi.fn();
      const dispatcher = createVoiceToolDispatcher({
        ...deps,
        callerKind,
        conversationId: "test",
        sendPhoneSms: sender,
      });
      const result = await dispatcher.dispatch({
        callId: "tool-1",
        name: "send_info_sms",
        args,
      });
      expect(result.result).toMatchObject({ ok: false });
      expect(sender).not.toHaveBeenCalled();
    },
  );
  it("dispatches business texting for Advisors without requiring a Breathe sales pitch", async () => {
    const sender = vi.fn().mockResolvedValue({ ok: true, status: "submitted" });
    const dispatcher = createVoiceToolDispatcher({
      ...deps,
      callerKind: "breathe_prospect",
      conversationId: "test",
      sendPhoneSms: sender,
    });
    await dispatcher.dispatch({
      callId: "reason",
      name: "identify_call_reason",
      args: { reason: "healthcare_advisors", product: "advisors" },
    });
    expect(
      (
        await dispatcher.dispatch({
          callId: "text",
          name: "send_info_sms",
          args,
        })
      ).result,
    ).toMatchObject({ status: "submitted" });
    expect(sender).toHaveBeenCalledOnce();
  });
});
