// Tests for the recall send-side worker.
//
// Coverage of the pure dispatch helper (sendRecallNotification):
//   * email-with-creds wins over sms
//   * sms fallback when no email present
//   * skipped + no_contact_channels when neither is usable
//   * failed when twilio throws
//   * SMS sends carry the status-callback URL (delivery tracking) and
//     surface the accepted message SID

import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendEmailMock, sendSmsMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => undefined),
  sendSmsMock: vi.fn(async () => ({ messageSid: "SM_test_sid" })),
}));

vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: vi.fn(() => ({
    sendEmail: sendEmailMock,
  })),
}));
vi.mock("@workspace/resupply-telecom", () => ({
  createTwilioSmsClient: vi.fn(() => ({
    sendSms: sendSmsMock,
  })),
}));

import { createSendgridClient } from "@workspace/resupply-email";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { sendRecallNotification } from "./recall-notifications-send";

const NOTIFICATION_ID = "55555555-5555-4555-8555-555555555555";

const RECALL = {
  id: "r_1",
  title: "DreamStation foam recall",
  description: "Replacement program details inside.",
  severity: "urgent",
  recallReference: "FDA-Z-1234-2026",
  referenceUrl: "https://example.com/recall",
};
const PATIENT_BOTH = {
  id: "p_1",
  email: "pat@example.com",
  phoneE164: "+15555550100",
};
const PATIENT_SMS_ONLY = {
  id: "p_2",
  email: null,
  phoneE164: "+15555550100",
};
const PATIENT_NONE = { id: "p_3", email: null, phoneE164: null };

const CFG_FULL = {
  sendgridApiKey: "SG.fake",
  sendgridFromEmail: "no-reply@example.com",
  sendgridFromName: "Test",
  twilioAccountSid: "AC.fake",
  twilioAuthToken: "auth.fake",
  twilioPhoneNumber: "+15555550000",
  twilioMessagingServiceSid: null,
  practiceName: "Test DME",
  publicBaseUrl: "https://test.example.com",
};
const CFG_NO_EMAIL = { ...CFG_FULL, sendgridApiKey: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendRecallNotification", () => {
  it("prefers email when patient + cfg both support it", async () => {
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_BOTH,
      },
      CFG_FULL,
    );
    expect(r).toEqual({
      kind: "sent",
      channel: "email",
      twilioMessageSid: null,
    });
    expect(createSendgridClient).toHaveBeenCalled();
    expect(createTwilioSmsClient).not.toHaveBeenCalled();
  });

  it("falls back to SMS when no email address", async () => {
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_SMS_ONLY,
      },
      CFG_FULL,
    );
    expect(r).toEqual({
      kind: "sent",
      channel: "sms",
      twilioMessageSid: "SM_test_sid",
    });
    expect(createTwilioSmsClient).toHaveBeenCalled();
  });

  it("passes the recall status-callback URL to the SMS send", async () => {
    await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_SMS_ONLY,
      },
      CFG_FULL,
    );
    expect(sendSmsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: PATIENT_SMS_ONLY.phoneE164,
        statusCallbackUrl: `https://test.example.com/resupply-api/sms/status-callback?recallNotificationId=${NOTIFICATION_ID}`,
      }),
    );
  });

  it("omits the status-callback URL when no public base URL is configured", async () => {
    await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_SMS_ONLY,
      },
      { ...CFG_FULL, publicBaseUrl: null },
    );
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    // The mock is typed zero-arg, so read the call args via unknown[][].
    const args = (sendSmsMock.mock.calls as unknown[][])[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("statusCallbackUrl");
  });

  it("skips with no_contact_channels when neither channel is usable", async () => {
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_NONE,
      },
      CFG_FULL,
    );
    expect(r).toEqual({ kind: "skipped", reason: "no_contact_channels" });
  });

  it("skips when patient has email but cfg lacks SendGrid AND no SMS path", async () => {
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: { id: "p", email: "pat@example.com", phoneE164: null },
      },
      CFG_NO_EMAIL,
    );
    expect(r).toEqual({ kind: "skipped", reason: "no_contact_channels" });
  });

  it("falls back to SMS when SendGrid throws", async () => {
    (
      createSendgridClient as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => ({
      sendEmail: vi.fn(async () => {
        throw new Error("vendor down");
      }),
    }));
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_BOTH,
      },
      CFG_FULL,
    );
    expect(r).toEqual({
      kind: "sent",
      channel: "sms",
      twilioMessageSid: "SM_test_sid",
    });
  });

  it("returns failed when SMS path also throws", async () => {
    (
      createTwilioSmsClient as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => ({
      sendSms: vi.fn(async () => {
        throw new Error("twilio rejected");
      }),
    }));
    const r = await sendRecallNotification(
      {
        notificationId: NOTIFICATION_ID,
        recall: RECALL,
        patient: PATIENT_SMS_ONLY,
      },
      CFG_NO_EMAIL,
    );
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.channel).toBe("sms");
      expect(r.reason).toContain("twilio rejected");
    }
  });
});
