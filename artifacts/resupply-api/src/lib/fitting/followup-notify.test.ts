// Tests for the fitter follow-up messages themselves.
//
// The copy is the product here, so what is pinned is what actually
// reaches the patient:
//   * the `no_request` message carries NO link, because the page it
//     would point at is guarded by per-tab state the patient no longer
//     has — a link there would drop somebody who ALREADY finished a
//     fitting back at the start of one;
//   * the two live-link messages carry a token whose lifetime matches
//     the invite row's, since the row is the real gate;
//   * an in-office handover is never auto-sent;
//   * consent is the CALLER's job — this module sends on the channels it
//     is handed and refuses when handed none;
//   * a vendor failure is reported, never thrown, and never logs the
//     recipient.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { EmailConfigError } from "@workspace/resupply-email";

const sendEmail = vi.hoisted(() => vi.fn(async (_args: unknown) => undefined));
const sendSms = vi.hoisted(() => vi.fn(async (_args: unknown) => undefined));
const emailConfigured = vi.hoisted(() => ({ value: true }));
const smsConfigured = vi.hoisted(() => ({ value: true }));

vi.mock("../email/tenant-sender.js", () => ({
  createTenantSendgridClient: vi.fn(async () => {
    if (!emailConfigured.value) {
      throw new EmailConfigError("SENDGRID_API_KEY is not set");
    }
    return { sendEmail };
  }),
}));

vi.mock("@workspace/resupply-telecom", async (importActual) => {
  const actual =
    await importActual<typeof import("@workspace/resupply-telecom")>();
  return {
    ...actual,
    createTwilioSmsClient: vi.fn(() => {
      if (!smsConfigured.value) {
        throw new actual.TwilioConfigError("TWILIO_AUTH_TOKEN is not set");
      }
      return { sendSms };
    }),
  };
});

vi.mock("../messaging/tenant-telecom.js", () => ({
  resolveTenantSmsClientOptions: vi.fn(async () => ({})),
}));

vi.mock("../tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: "Foo DME",
    legalName: "Foo DME LLC",
    tagline: "",
    logoUrl: null,
  })),
}));

vi.mock("../company-info.js", () => ({
  getCompanyInfo: vi.fn(async () => ({
    name: "Foo DME",
    supportPhoneDisplay: "(814) 555-0142",
  })),
}));

const signToken = vi.hoisted(() =>
  vi.fn((_id: string, _at: Date, _ttl: number) => "SIGNED_TOKEN"),
);
vi.mock("../fitter-invite-token.js", () => ({
  signFitterInviteToken: signToken,
}));

import { sendFitterFollowup } from "./followup-notify";

const BASE = {
  orgId: "org-1",
  inviteId: "invite-1",
  recipientEmail: "jordan@example.com",
  recipientPhoneE164: "+12155550137",
  recipientName: "Jordan Avery",
  allowEmail: true,
  allowSms: true,
  linkBase: "https://tenant.example",
  linkTtlMs: 12 * 86_400_000,
};

function lastEmail(): { subject: string; html: string; text: string } {
  return sendEmail.mock.calls.at(-1)?.[0] as {
    subject: string;
    html: string;
    text: string;
  };
}

beforeEach(() => {
  sendEmail.mockClear();
  sendSms.mockClear();
  signToken.mockClear();
  emailConfigured.value = true;
  smsConfigured.value = true;
});

describe("the fitting is done — no link, a phone number instead", () => {
  it("sends no link at all", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email" },
      "no_request",
    );
    expect(res.delivered).toBe(true);
    const mail = lastEmail();
    expect(mail.html).not.toContain("/fitter-invite");
    expect(mail.text).not.toContain("/fitter-invite");
    // …and does not mint a token it would have no use for.
    expect(signToken).not.toHaveBeenCalled();
  });

  it("gives them the practice's number and an invitation to reply", async () => {
    await sendFitterFollowup({ ...BASE, channel: "email" }, "no_request");
    const mail = lastEmail();
    expect(mail.text).toContain("(814) 555-0142");
    expect(mail.text).toContain("reply to this email");
  });

  it("says nothing has been ordered or billed", async () => {
    // The patient is insurance-only and nothing has been charged. A
    // follow-up about equipment that did not say so would read as a bill.
    await sendFitterFollowup({ ...BASE, channel: "email" }, "no_request");
    expect(lastEmail().text).toContain("Nothing has been ordered or billed");
  });

  it("works for a tenant with no verified domain", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email", linkBase: null, linkTtlMs: undefined },
      "no_request",
    );
    expect(res.delivered).toBe(true);
  });
});

describe("the link still works — resume where they left off", () => {
  it("mints a token whose life matches the invite row's", async () => {
    // The ROW is the real gate (routes/shop/fitter-invite.ts), so a
    // longer-lived token would advertise a link that dead-ends early.
    await sendFitterFollowup({ ...BASE, channel: "email" }, "unstarted");
    expect(signToken).toHaveBeenCalledWith(
      "invite-1",
      expect.any(Date),
      12 * 86_400_000,
    );
    expect(lastEmail().html).toContain(
      "https://tenant.example/fitter-invite?t=SIGNED_TOKEN",
    );
  });

  it("names the fact that they started, when they did", async () => {
    await sendFitterFollowup({ ...BASE, channel: "email" }, "abandoned");
    const mail = lastEmail();
    expect(mail.subject).toContain("nearly done");
    expect(mail.text).toContain("didn't get to the end");
  });

  it("refuses rather than sending a link it cannot build", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email", linkBase: null },
      "unstarted",
    );
    expect(res.delivered).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("says the LINK is unavailable, not that we have no contact", async () => {
    // Both end in "nothing sent", but they are different problems with
    // different fixes, and this reason is recorded as telemetry on the
    // staff worklist. Reporting `no_contact` here would send an operator
    // hunting for a missing email address when every address is fine and
    // the tenant simply has no verified domain.
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email", linkBase: null },
      "unstarted",
    );
    expect(res.reason).toBe("link_unavailable");

    const noContact = await sendFitterFollowup(
      { ...BASE, channel: "email", allowEmail: false, allowSms: false },
      "unstarted",
    );
    expect(noContact.reason).toBe("no_contact");
  });
});

describe("channel selection", () => {
  it("stays on the channel the invitation used", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "sms" },
      "unstarted",
    );
    expect(res.channel).toBe("sms");
    expect(sendSms).toHaveBeenCalledTimes(1);
    const body = (sendSms.mock.calls[0]?.[0] as { body: string }).body;
    expect(body).toContain("SIGNED_TOKEN");
    expect(body).toContain("Reply STOP");
  });

  it("falls back to email when SMS is not permitted", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "sms", allowSms: false },
      "unstarted",
    );
    expect(res.channel).toBe("email");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("never auto-picks a channel for an in-office handover", async () => {
    // The row carries a chart's email and phone incidentally; "nothing is
    // sent" was the contract staff chose at the counter.
    const res = await sendFitterFollowup(
      { ...BASE, channel: "in_office" },
      "unstarted",
    );
    expect(res).toMatchObject({
      delivered: false,
      reason: "in_office_handoff",
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("reports no_contact when the caller permits nothing", async () => {
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email", allowEmail: false, allowSms: false },
      "unstarted",
    );
    expect(res).toMatchObject({ delivered: false, reason: "no_contact" });
  });
});

describe("failure is reported, never thrown", () => {
  it("reports a tenant with no email credentials", async () => {
    emailConfigured.value = false;
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email", allowSms: false },
      "unstarted",
    );
    expect(res).toMatchObject({
      delivered: false,
      reason: "no_channel_config",
    });
  });

  it("reports a tenant with no SMS credentials", async () => {
    smsConfigured.value = false;
    const res = await sendFitterFollowup(
      { ...BASE, channel: "sms", allowEmail: false },
      "unstarted",
    );
    expect(res).toMatchObject({
      delivered: false,
      reason: "no_channel_config",
    });
  });

  it("swallows a vendor throw", async () => {
    sendEmail.mockRejectedValueOnce(new Error("SendGrid 503"));
    const res = await sendFitterFollowup(
      { ...BASE, channel: "email" },
      "unstarted",
    );
    expect(res).toMatchObject({ delivered: false, reason: "send_failed" });
  });
});

describe("PHI and header safety", () => {
  it("keeps the recipient's name out of the subject line", async () => {
    // Inbox subjects are not encrypted.
    await sendFitterFollowup({ ...BASE, channel: "email" }, "unstarted");
    expect(lastEmail().subject).not.toContain("Jordan");
  });

  it("strips CR/LF from a brand before it reaches a header", async () => {
    const { resolveBrandingByOrgId } = await import("../tenant-branding.js");
    vi.mocked(resolveBrandingByOrgId).mockResolvedValueOnce({
      storefrontName: "Foo\r\nBcc: attacker@example.com",
      legalName: "Foo",
      tagline: "",
      logoUrl: null,
    } as never);
    await sendFitterFollowup({ ...BASE, channel: "email" }, "unstarted");
    expect(lastEmail().subject).not.toMatch(/[\r\n]/);
  });

  it("greets a contact with no name on file without saying 'null'", async () => {
    await sendFitterFollowup(
      { ...BASE, channel: "email", recipientName: null },
      "unstarted",
    );
    expect(lastEmail().text).toContain("Hi there,");
  });
});
