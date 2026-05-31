// End-to-end dispatch test: drives dispatchAlert all the way to the
// vendor-client call and asserts the EXACT payload handed to SendGrid /
// Twilio — the wire-level surface the outcome-focused tests in
// dispatch.test.ts and dispatch.override.test.ts don't cover.
//
// Strategy:
//   * vi.mock the resupply-email / resupply-telecom modules so the send
//     functions are spies that capture their input (no network).
//   * vi.hoisted sets the SendGrid + Twilio env so the per-channel
//     config readers (readEmailConfigOrNull / readSmsConfigOrNull)
//     return a configured object rather than null.
//   * The shared supabase mock stages the alert_definitions /
//     alert_messages / alert_message_overrides / patients reads.
//
// What we pin:
//   * email subject + plain-text body are variable-substituted.
//   * email with NO html body sends an HTML-ESCAPED <pre> wrapper as the
//     `html` part (the XSS guard) — not the raw text.
//   * a supplied html body is used verbatim (escaped per-variable by the
//     renderer, not re-wrapped).
//   * sms sends the rendered text as the body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Make readEmailConfigOrNull() + readSmsConfigOrNull() return config.
  process.env.SENDGRID_API_KEY = "SG.test";
  process.env.SENDGRID_FROM_EMAIL = "info@pennpaps.com";
  process.env.SENDGRID_FROM_NAME = "PennPaps";
  process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = "test-pub-key";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_PHONE_NUMBER = "+12158675309";
  process.env.RAILWAY_PUBLIC_DOMAIN = "pennfit.up.railway.app";
  process.env.RESUPPLY_PRACTICE_NAME = "PennPaps";
});

interface SentEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  customArgs?: Record<string, string>;
}
interface SentSms {
  to: string;
  body: string;
}
const sendEmail = vi.fn(async (_input: SentEmail) => ({ messageId: "sg_123" }));
const sendSms = vi.fn(async (_input: SentSms) => ({ messageSid: "SM_123" }));

vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => ({ sendEmail }),
  EmailApiError: class EmailApiError extends Error {},
  EmailConfigError: class EmailConfigError extends Error {},
}));

vi.mock("@workspace/resupply-telecom", () => ({
  createTwilioSmsClient: () => ({ sendSms }),
  createTwilioClient: () => ({ placeCall: vi.fn() }),
  TwilioApiError: class TwilioApiError extends Error {},
  TwilioConfigError: class TwilioConfigError extends Error {},
}));

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { dispatchAlert } from "./dispatch";

const DEF = {
  key: "order_shipped",
  channels: ["email", "sms", "voice"],
  allowed_variables: [
    "first_name",
    "practice_name",
    "order_number",
    "tracking_url",
  ],
  is_active: true,
};

const ACTIVE_PATIENT = {
  id: "p_1",
  status: "active",
  email: "sam@example.com",
  phone_e164: "+12155551212",
  legal_first_name: "Sam",
};

function stageDefAndPatient(message: {
  subject: string | null;
  body_html: string | null;
  body_text: string;
}) {
  stageSupabaseResponse("alert_definitions", "select", { data: DEF });
  stageSupabaseResponse("alert_messages", "select", {
    data: { ...message, is_active: true },
  });
  stageSupabaseResponse("alert_message_overrides", "select", { data: null });
  stageSupabaseResponse("patients", "select", { data: ACTIVE_PATIENT });
}

beforeEach(() => {
  supabaseMock.reset();
  sendEmail.mockClear();
  sendSms.mockClear();
});

afterEach(() => {
  supabaseMock.reset();
});

describe("dispatchAlert — vendor payload (email)", () => {
  it("substitutes variables into subject + text and HTML-wraps a text-only body", async () => {
    stageDefAndPatient({
      subject: "Your {{practice_name}} order {{order_number}} shipped",
      body_html: null,
      body_text: "Hi {{first_name}}, order {{order_number}} is on its way.",
    });

    const outcome = await dispatchAlert({
      alertKey: "order_shipped",
      channel: "email",
      patientId: "p_1",
      variables: { order_number: "A-100", tracking_url: "https://x/y" },
    });

    expect(outcome.status).toBe("ok");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const payload = sendEmail.mock.calls[0]![0];
    expect(payload.to).toBe("sam@example.com");
    expect(payload.subject).toBe("Your PennPaps order A-100 shipped");
    expect(payload.text).toBe("Hi Sam, order A-100 is on its way.");
    // No html body in the template → the plain text is wrapped in a
    // <pre> (HTML-escaped) rather than sent raw.
    expect(payload.html).toBe(
      '<pre style="font-family:inherit;white-space:pre-wrap;">Hi Sam, order A-100 is on its way.</pre>',
    );
    expect(payload.customArgs).toMatchObject({
      kind: "alert",
      alert_key: "order_shipped",
    });
  });

  it("HTML-escapes interpolated values when wrapping a text-only body", async () => {
    stageDefAndPatient({
      subject: "Order update",
      body_html: null,
      // first_name resolves to a value with HTML-significant chars.
      body_text: "Hi {{first_name}}.",
    });

    const outcome = await dispatchAlert({
      alertKey: "order_shipped",
      channel: "email",
      patientId: "p_1",
      variables: { first_name: "<b>Sam</b> & Co" },
    });

    expect(outcome.status).toBe("ok");
    const payload = sendEmail.mock.calls[0]![0];
    // The angle brackets / ampersand are escaped in the html part.
    expect(payload.html).toContain("&lt;b&gt;Sam&lt;/b&gt; &amp; Co");
    expect(payload.html).not.toContain("<b>Sam</b>");
  });

  it("uses a supplied html body verbatim (renderer escapes per-variable)", async () => {
    stageDefAndPatient({
      subject: "Order {{order_number}}",
      body_html: "<p>Hi {{first_name}}, see {{tracking_url}}</p>",
      body_text: "Hi {{first_name}}",
    });

    const outcome = await dispatchAlert({
      alertKey: "order_shipped",
      channel: "email",
      patientId: "p_1",
      variables: { order_number: "A-100", tracking_url: "https://x/y" },
    });

    expect(outcome.status).toBe("ok");
    const payload = sendEmail.mock.calls[0]![0];
    expect(payload.html).toBe("<p>Hi Sam, see https://x/y</p>");
  });
});

describe("dispatchAlert — vendor payload (sms)", () => {
  it("sends the rendered text as the sms body", async () => {
    stageDefAndPatient({
      subject: null,
      body_html: null,
      body_text: "Hi {{first_name}}, order {{order_number}} shipped.",
    });

    const outcome = await dispatchAlert({
      alertKey: "order_shipped",
      channel: "sms",
      patientId: "p_1",
      variables: { order_number: "A-100", tracking_url: "https://x/y" },
    });

    expect(outcome.status).toBe("ok");
    expect(sendSms).toHaveBeenCalledTimes(1);
    const payload = sendSms.mock.calls[0]![0];
    expect(payload.to).toBe("+12155551212");
    expect(payload.body).toBe("Hi Sam, order A-100 shipped.");
  });
});
