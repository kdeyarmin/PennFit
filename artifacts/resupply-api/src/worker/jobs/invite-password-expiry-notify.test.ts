// Tests for the invite-password expiry-notify dispatcher.
//
// Covers:
//   * the pure compose helpers (subject + body shape, HTML escaping);
//   * the no-config short-circuit;
//   * the happy path (reminder + expired email each send once and
//     stamp the matching column);
//   * the re-invite case (older stamp on a newer set_by_admin_at
//     still triggers a fresh reminder);
//   * the already-claimed branch (stamp ahead of set_by_admin_at →
//     no email).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: () => ({
    sendEmail: sendEmailMock,
  }),
}));

// Per-recipient tenant branding: "org-b" is a second tenant; any other
// org (or none) falls back to the seed/platform copy.
vi.mock("../../lib/tenant-branding", () => ({
  resolveBrandingByOrgId: vi.fn(async (orgId?: string) => ({
    storefrontName: orgId === "org-b" ? "Foo DME" : "Penn Home Medical Supply",
    legalName: orgId === "org-b" ? "Foo DME LLC" : "Penn Home Medical Supply",
    tagline: "",
    logoUrl: null,
  })),
  resolveTenantBaseUrl: vi.fn(async (orgId?: string) =>
    orgId === "org-b" ? "https://foodme.example" : null,
  ),
}));

import {
  composeReminderEmail,
  composeExpiredEmail,
  runInvitePasswordExpiryNotifySweep,
} from "./invite-password-expiry-notify";

const FULL_CFG = {
  sendgridApiKey: "SG.fake",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "Penn Home Medical Supply",
  practiceName: "Penn Home Medical Supply",
  publicBaseUrl: "https://pennfit.example",
};

const TTL_MS = 7 * 86_400_000;

beforeEach(() => {
  sendEmailMock.mockClear();
  supabaseMock.reset();
});

describe("composeReminderEmail", () => {
  it("uses the practice name in subject + body and includes the sign-in link", () => {
    const out = composeReminderEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://example.test",
      displayName: "Pat",
      hoursRemaining: 47,
    });
    expect(out.subject).toBe("Your Foo DME invite expires soon");
    expect(out.text).toContain("Hi Pat,");
    expect(out.text).toContain("Foo DME");
    expect(out.text).toContain("47 hours");
    expect(out.html).toContain("https://example.test/admin/sign-in");
  });

  it("escapes user-controlled practice name in HTML", () => {
    const out = composeReminderEmail({
      practiceName: "<script>x</script>",
      publicBaseUrl: "https://x",
      displayName: null,
      hoursRemaining: 1,
    });
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("composeExpiredEmail", () => {
  it("tells the user to ask for a new invite", () => {
    const out = composeExpiredEmail({
      practiceName: "Penn Home Medical Supply",
      displayName: null,
    });
    expect(out.subject).toBe(
      "Your Penn Home Medical Supply invite has expired",
    );
    expect(out.text.toLowerCase()).toContain("expired");
    expect(out.text).toContain("send a new invite");
  });
});

describe("runInvitePasswordExpiryNotifySweep", () => {
  it("exits cleanly when SendGrid creds are missing", async () => {
    const stats = await runInvitePasswordExpiryNotifySweep({
      ...FULL_CFG,
      sendgridApiKey: null,
    });
    expect(stats.skippedNoConfig).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("sends one reminder and one expired email per eligible row and stamps the matching columns", async () => {
    const setRecent = new Date(Date.now() - 5.5 * 86_400_000).toISOString();
    const setOld = new Date(Date.now() - TTL_MS - 86_400_000).toISOString();

    // reminder candidate query
    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-1",
          set_by_admin_at: setRecent,
          expiry_reminder_sent_at: null,
          expired_notice_sent_at: null,
        },
      ],
    });
    // expired candidate query
    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-2",
          set_by_admin_at: setOld,
          expiry_reminder_sent_at: null,
          expired_notice_sent_at: null,
        },
      ],
    });
    // user lookup
    stageSupabaseResponse("users", "select", {
      data: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: "Pat",
          status: "invited",
        },
        {
          id: "u-2",
          email_lower: "sam@example.test",
          display_name: null,
          status: "invited",
        },
      ],
    });
    // reminder claim + send
    stageSupabaseResponse("password_credentials", "update", {
      data: [{ user_id: "u-1" }],
    });
    // expired claim + send
    stageSupabaseResponse("password_credentials", "update", {
      data: [{ user_id: "u-2" }],
    });

    const stats = await runInvitePasswordExpiryNotifySweep(FULL_CFG);

    expect(stats.remindersSent).toBe(1);
    expect(stats.expiredSent).toBe(1);
    expect(stats.errors).toBe(0);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const recipients = (
      sendEmailMock.mock.calls as unknown as Array<[{ to: string }]>
    ).map(([arg]) => arg.to);
    expect(recipients).toContain("pat@example.test");
    expect(recipients).toContain("sam@example.test");

    const writes = getSupabaseWritePayloads(
      "password_credentials",
      "update",
    ) as Array<Record<string, string>>;
    expect(writes[0]).toHaveProperty("expiry_reminder_sent_at");
    expect(writes[1]).toHaveProperty("expired_notice_sent_at");
  });

  it("brands the email with the recipient's own tenant (name + sign-in URL)", async () => {
    const setRecent = new Date(Date.now() - 5.5 * 86_400_000).toISOString();
    // reminder candidate
    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-9",
          set_by_admin_at: setRecent,
          expiry_reminder_sent_at: null,
          expired_notice_sent_at: null,
        },
      ],
    });
    // no expired candidates
    stageSupabaseResponse("password_credentials", "select", { data: [] });
    stageSupabaseResponse("users", "select", {
      data: [
        {
          id: "u-9",
          email_lower: "ann@foodme.test",
          display_name: "Ann",
          status: "invited",
        },
      ],
    });
    // user → tenant map (admin_users.auth_user_id → org_id)
    stageSupabaseResponse("admin_users", "select", {
      data: [{ auth_user_id: "u-9", org_id: "org-b" }],
    });
    stageSupabaseResponse("password_credentials", "update", {
      data: [{ user_id: "u-9" }],
    });

    await runInvitePasswordExpiryNotifySweep(FULL_CFG);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0]?.[0] as unknown as {
      subject: string;
      html: string;
    };
    // Tenant brand in the subject, tenant custom domain in the sign-in link —
    // NOT the seed "Penn Home Medical Supply" / platform host from FULL_CFG.
    expect(call.subject).toBe("Your Foo DME invite expires soon");
    expect(call.html).toContain("https://foodme.example/admin/sign-in");
  });

  it("re-invites get a fresh reminder even when an older stamp exists", async () => {
    // Stamp from a previous invite, now older than the brand-new
    // set_by_admin_at.
    const setRecent = new Date(Date.now() - 5.5 * 86_400_000).toISOString();
    const oldStamp = new Date(Date.now() - 30 * 86_400_000).toISOString();

    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-1",
          set_by_admin_at: setRecent,
          expiry_reminder_sent_at: oldStamp,
          expired_notice_sent_at: oldStamp,
        },
      ],
    });
    stageSupabaseResponse("password_credentials", "select", { data: [] });
    stageSupabaseResponse("users", "select", {
      data: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: "Pat",
          status: "invited",
        },
      ],
    });
    stageSupabaseResponse("password_credentials", "update", {
      data: [{ user_id: "u-1" }],
    });

    const stats = await runInvitePasswordExpiryNotifySweep(FULL_CFG);
    expect(stats.remindersSent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("skips rows whose reminder stamp is newer than the current set_by_admin_at", async () => {
    const setRecent = new Date(Date.now() - 5.5 * 86_400_000).toISOString();
    const freshStamp = new Date(Date.now() - 3_600_000).toISOString();

    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-1",
          set_by_admin_at: setRecent,
          expiry_reminder_sent_at: freshStamp,
          expired_notice_sent_at: null,
        },
      ],
    });
    stageSupabaseResponse("password_credentials", "select", { data: [] });

    const stats = await runInvitePasswordExpiryNotifySweep(FULL_CFG);
    expect(stats.remindersSent).toBe(0);
    expect(stats.scannedReminders).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips revoked users", async () => {
    const setRecent = new Date(Date.now() - 5.5 * 86_400_000).toISOString();
    stageSupabaseResponse("password_credentials", "select", {
      data: [
        {
          user_id: "u-1",
          set_by_admin_at: setRecent,
          expiry_reminder_sent_at: null,
          expired_notice_sent_at: null,
        },
      ],
    });
    stageSupabaseResponse("password_credentials", "select", { data: [] });
    stageSupabaseResponse("users", "select", {
      data: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: "Pat",
          status: "revoked",
        },
      ],
    });

    const stats = await runInvitePasswordExpiryNotifySweep(FULL_CFG);
    expect(stats.remindersSent).toBe(0);
    expect(stats.skippedNoEmail).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
