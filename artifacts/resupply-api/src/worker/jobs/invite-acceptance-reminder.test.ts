// Tests for the "invited but never signed in" nudge sweep.
//
// Covers:
//   * the pure compose helper (per-kind CTA, final vs mid-window copy,
//     HTML escaping, and the absence of a set-password link);
//   * the empty-scan short-circuit;
//   * the happy path for both invite kinds, including which stamp column
//     each nudge window claims;
//   * the acceptance gate (a user who redeemed their invite is filtered out
//     by the query, and a genuine password-reset token never nudges);
//   * the dedupe guards — stamp already current for this token, and the lost
//     compare-and-swap race;
//   * the re-invite case (stamp predating a fresh token nudges again);
//   * the skips: revoked staff seat, unmapped identity (provider portal),
//     and a tenant with no verified domain;
//   * mutual exclusivity of the two windows (never two emails in one run).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const sendEmailMock = vi.fn(
  async (..._args: unknown[]) => undefined as unknown,
);
vi.mock("../../lib/email/tenant-sender.js", () => ({
  createTenantSendgridClient: vi.fn(async () => ({
    sendEmail: sendEmailMock,
  })),
}));

// "org-b" is a second tenant with its own verified domain; "org-nodomain"
// has none, which must skip the send rather than mint a platform-host link
// that would resolve to the wrong tenant.
vi.mock("../../lib/tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async (orgId?: string) => ({
    storefrontName: orgId === "org-b" ? "Foo DME" : "Penn Home Medical Supply",
    legalName: orgId === "org-b" ? "Foo DME LLC" : "Penn Home Medical Supply",
    tagline: "",
    logoUrl: null,
  })),
  resolveTenantLinkBaseUrl: vi.fn(
    async (orgId?: string, platformFallback?: string) => {
      if (orgId === "org-nodomain") return null;
      if (orgId === "org-b") return "https://foodme.example";
      return (platformFallback ?? "https://pennfit.example").replace(/\/$/, "");
    },
  ),
}));

import {
  composeInviteReminderEmail,
  runInviteAcceptanceReminderSweep,
} from "./invite-acceptance-reminder";

const CFG = { publicBaseUrl: "https://pennfit.example" };

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** ISO timestamp `ms` in the future. */
function inMs(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
/** ISO timestamp `ms` in the past. */
function agoMs(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/**
 * Stage the four reads the sweep makes before it starts claiming rows.
 * Anything omitted defaults to "nothing found".
 */
function stageScan(opts: {
  tokens?: unknown[];
  users?: unknown[];
  staff?: unknown[];
  patients?: unknown[];
}) {
  stageSupabaseResponse("email_tokens", "select", { data: opts.tokens ?? [] });
  if (opts.tokens && opts.tokens.length > 0) {
    stageSupabaseResponse("users", "select", { data: opts.users ?? [] });
  }
  if (opts.users && opts.users.length > 0) {
    stageSupabaseResponse("admin_users", "select", { data: opts.staff ?? [] });
    stageSupabaseResponse("patients", "select", { data: opts.patients ?? [] });
  }
}

beforeEach(() => {
  sendEmailMock.mockClear();
  supabaseMock.reset();
});

describe("composeInviteReminderEmail", () => {
  it("points staff at the admin recovery page and names the tenant", () => {
    const out = composeInviteReminderEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://foodme.example",
      displayName: "Pat",
      kind: "staff",
      msRemaining: 3 * DAY,
      final: false,
    });
    expect(out.subject).toBe("Finish setting up your Foo DME team account");
    expect(out.text).toContain("Hi Pat,");
    expect(out.text).toContain("3 days");
    expect(out.html).toContain("https://foodme.example/admin/forgot-password");
  });

  it("points portal patients at the storefront recovery page", () => {
    const out = composeInviteReminderEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://foodme.example",
      displayName: null,
      kind: "patient",
      msRemaining: 3 * DAY,
      final: false,
    });
    expect(out.subject).toBe(
      "Finish setting up your Foo DME patient portal account",
    );
    expect(out.text).toContain("Hi,");
    expect(out.html).toContain("https://foodme.example/forgot-password");
    expect(out.html).not.toContain("/admin/forgot-password");
  });

  it("switches to expiry framing for the final nudge and reports hours", () => {
    const out = composeInviteReminderEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://foodme.example",
      displayName: "Pat",
      kind: "staff",
      msRemaining: 5 * HOUR,
      final: true,
    });
    expect(out.subject).toBe("Last chance to set up your Foo DME team account");
    expect(out.text).toContain("expires in about 5 hours");
  });

  it("never carries a set-password link (the raw token is unrecoverable)", () => {
    const out = composeInviteReminderEmail({
      practiceName: "Foo DME",
      publicBaseUrl: "https://foodme.example",
      displayName: null,
      kind: "staff",
      msRemaining: 2 * DAY,
      final: false,
    });
    expect(out.html).not.toContain("reset-password");
    expect(out.text).not.toContain("token=");
  });

  it("escapes a tenant-controlled practice name in HTML", () => {
    const out = composeInviteReminderEmail({
      practiceName: "<script>x</script>",
      publicBaseUrl: "https://x",
      displayName: null,
      kind: "staff",
      msRemaining: DAY,
      final: false,
    });
    expect(out.html).not.toContain("<script>x</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("runInviteAcceptanceReminderSweep", () => {
  it("short-circuits when no invite link is inside a nudge window", async () => {
    stageScan({ tokens: [] });
    const stats = await runInviteAcceptanceReminderSweep(CFG);
    expect(stats.scannedTokens).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("users", "update")).toBe(0);
  });

  it("nudges a staff invitee mid-window and stamps invite_reminder_sent_at", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(3 * DAY),
          created_at: agoMs(4 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: "Pat",
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "pending" }],
    });
    stageSupabaseResponse("users", "update", { data: [{ id: "u-1" }] });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.pendingInvites).toBe(1);
    expect(stats.remindersSent).toBe(1);
    expect(stats.finalRemindersSent).toBe(0);
    expect(stats.errors).toBe(0);

    const [payload] = getSupabaseWritePayloads("users", "update") as Array<
      Record<string, string>
    >;
    expect(payload).toHaveProperty("invite_reminder_sent_at");
    expect(payload).not.toHaveProperty("invite_final_reminder_sent_at");
    // Not an identity change — updated_at must not be bumped.
    expect(payload).not.toHaveProperty("updated_at");

    const [[arg]] = sendEmailMock.mock.calls as unknown as Array<
      [{ to: string; subject: string; html: string }]
    >;
    expect(arg.to).toBe("pat@example.test");
    // Branded to the invitee's own tenant, not the platform.
    expect(arg.subject).toContain("Foo DME");
    expect(arg.html).toContain("https://foodme.example/admin/forgot-password");
  });

  it("uses the final stamp column and final copy inside the last day", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(6 * HOUR),
          created_at: agoMs(7 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          // Mid-window nudge already went out for this same invite.
          invite_reminder_sent_at: agoMs(3 * DAY),
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "pending" }],
    });
    stageSupabaseResponse("users", "update", { data: [{ id: "u-1" }] });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.finalRemindersSent).toBe(1);
    expect(stats.remindersSent).toBe(0);
    const [payload] = getSupabaseWritePayloads("users", "update") as Array<
      Record<string, string>
    >;
    expect(payload).toHaveProperty("invite_final_reminder_sent_at");
    // Exactly one email — the windows are mutually exclusive.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [[arg]] = sendEmailMock.mock.calls as unknown as Array<
      [{ subject: string }]
    >;
    expect(arg.subject).toContain("Last chance");
  });

  it("nudges a portal patient with the storefront recovery link", async () => {
    stageScan({
      tokens: [
        {
          user_id: "p-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "p-1",
          email_lower: "sam@example.test",
          display_name: "Sam",
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [],
      patients: [{ portal_auth_user_id: "p-1", org_id: "org-b" }],
    });
    stageSupabaseResponse("users", "update", { data: [{ id: "p-1" }] });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.remindersSent).toBe(1);
    const [[arg]] = sendEmailMock.mock.calls as unknown as Array<
      [{ subject: string; html: string }]
    >;
    expect(arg.subject).toContain("patient portal");
    expect(arg.html).toContain("https://foodme.example/forgot-password");
    expect(arg.html).not.toContain("/admin/forgot-password");
  });

  it("sends nothing when the invitee already accepted", async () => {
    // The acceptance gate lives in the users query (status='invited' AND
    // email_verified_at IS NULL), so an accepted invitee — or the owner of a
    // genuine forgot-password token — simply isn't returned.
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [],
    });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.scannedTokens).toBe(1);
    expect(stats.pendingInvites).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("users", "update")).toBe(0);
  });

  it("does not re-nudge when the stamp is already current for this invite", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          // Stamped AFTER the live token was minted → already nudged.
          invite_reminder_sent_at: agoMs(2 * DAY),
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "pending" }],
    });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.skippedAlreadyClaimed).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("users", "update")).toBe(0);
  });

  it("nudges again after a re-invite mints a newer token", async () => {
    stageScan({
      tokens: [
        // Fresh token, minted after the previous nudge.
        {
          user_id: "u-1",
          expires_at: inMs(3 * DAY),
          created_at: agoMs(4 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          // Stamp predates the live token → stale, so this invite gets its
          // own nudge rather than inheriting the previous invite's.
          invite_reminder_sent_at: agoMs(20 * DAY),
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "pending" }],
    });
    stageSupabaseResponse("users", "update", { data: [{ id: "u-1" }] });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.remindersSent).toBe(1);
    expect(stats.skippedAlreadyClaimed).toBe(0);
  });

  it("sends nothing when another worker wins the compare-and-swap", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "pending" }],
    });
    // Claim matches zero rows — someone else stamped it first.
    stageSupabaseResponse("users", "update", { data: [] });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.skippedAlreadyClaimed).toBe(1);
    expect(stats.remindersSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips a revoked staff seat", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [{ auth_user_id: "u-1", org_id: "org-b", status: "revoked" }],
    });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.skippedUnmappedUser).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("skips an identity with no roster row (provider portal is out of scope)", async () => {
    stageScan({
      tokens: [
        {
          user_id: "pr-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "pr-1",
          email_lower: "doc@example.test",
          display_name: null,
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [],
      patients: [],
    });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.skippedUnmappedUser).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(getSupabaseCallCount("users", "update")).toBe(0);
  });

  it("skips a tenant with no verified domain rather than sending a wrong-host link", async () => {
    stageScan({
      tokens: [
        {
          user_id: "u-1",
          expires_at: inMs(2 * DAY),
          created_at: agoMs(5 * DAY),
        },
      ],
      users: [
        {
          id: "u-1",
          email_lower: "pat@example.test",
          display_name: null,
          invite_reminder_sent_at: null,
          invite_final_reminder_sent_at: null,
        },
      ],
      staff: [
        { auth_user_id: "u-1", org_id: "org-nodomain", status: "pending" },
      ],
    });

    const stats = await runInviteAcceptanceReminderSweep(CFG);

    expect(stats.skippedNoTenant).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Nothing is claimed, so the invite is still nudgeable once the tenant
    // binds a domain.
    expect(getSupabaseCallCount("users", "update")).toBe(0);
  });
});
