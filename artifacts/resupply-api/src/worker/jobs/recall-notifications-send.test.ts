// Tests for the recall send-side worker.
//
// Coverage of the pure dispatch helper (sendRecallNotification):
//   * email-with-creds wins over sms
//   * sms fallback when no email present
//   * skipped + no_contact_channels when neither is usable
//   * failed when twilio throws

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: vi.fn(() => ({
    sendEmail: vi.fn(async () => undefined),
  })),
}));
vi.mock("@workspace/resupply-telecom", () => ({
  createTwilioSmsClient: vi.fn(() => ({
    sendSms: vi.fn(async () => undefined),
  })),
}));

import { createSendgridClient } from "@workspace/resupply-email";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { sendRecallNotification } from "./recall-notifications-send";

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
};
const CFG_NO_EMAIL = { ...CFG_FULL, sendgridApiKey: null };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendRecallNotification", () => {
  it("prefers email when patient + cfg both support it", async () => {
    const r = await sendRecallNotification(
      { recall: RECALL, patient: PATIENT_BOTH },
      CFG_FULL,
    );
    expect(r).toEqual({ kind: "sent", channel: "email" });
    expect(createSendgridClient).toHaveBeenCalled();
    expect(createTwilioSmsClient).not.toHaveBeenCalled();
  });

  it("falls back to SMS when no email address", async () => {
    const r = await sendRecallNotification(
      { recall: RECALL, patient: PATIENT_SMS_ONLY },
      CFG_FULL,
    );
    expect(r).toEqual({ kind: "sent", channel: "sms" });
    expect(createTwilioSmsClient).toHaveBeenCalled();
  });

  it("skips with no_contact_channels when neither channel is usable", async () => {
    const r = await sendRecallNotification(
      { recall: RECALL, patient: PATIENT_NONE },
      CFG_FULL,
    );
    expect(r).toEqual({ kind: "skipped", reason: "no_contact_channels" });
  });

  it("skips when patient has email but cfg lacks SendGrid AND no SMS path", async () => {
    const r = await sendRecallNotification(
      {
        recall: RECALL,
        patient: { id: "p", email: "pat@example.com", phoneE164: null },
      },
      CFG_NO_EMAIL,
    );
    expect(r).toEqual({ kind: "skipped", reason: "no_contact_channels" });
  });

  it("falls back to SMS when SendGrid throws", async () => {
    (createSendgridClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => ({
        sendEmail: vi.fn(async () => {
          throw new Error("vendor down");
        }),
      }),
    );
    const r = await sendRecallNotification(
      { recall: RECALL, patient: PATIENT_BOTH },
      CFG_FULL,
    );
    expect(r).toEqual({ kind: "sent", channel: "sms" });
  });

  it("returns failed when SMS path also throws", async () => {
    (createTwilioSmsClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => ({
        sendSms: vi.fn(async () => {
          throw new Error("twilio rejected");
        }),
      }),
    );
    const r = await sendRecallNotification(
      { recall: RECALL, patient: PATIENT_SMS_ONLY },
      CFG_NO_EMAIL,
    );
    expect(r.kind).toBe("failed");
    if (r.kind === "failed") {
      expect(r.channel).toBe("sms");
      expect(r.reason).toContain("twilio rejected");
    }
  });
});
