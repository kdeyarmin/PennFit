// POST /platform/tenants/:id/admins — set up a tenant's admin account
// from the platform console.
//
// This is the route that replaced "ssh into a box and run tenant:onboard"
// for the most ordinary onboarding step there is, so the cases that
// matter are the ones where getting it wrong is expensive: creating an
// account on the wrong tenant, clobbering an identity that belongs to
// another tenant, or leaving an account created with no way to reach it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin, inviteMock, sendgridMock } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
  inviteMock: vi.fn(),
  sendgridMock: vi.fn(),
}));

vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);
vi.mock("@workspace/resupply-auth", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  inviteTeamMember: inviteMock,
}));
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    publicBaseUrl: "https://cmbreathe.com",
    // The shared auth sender SWALLOWS delivery failures. The route
    // deliberately replaces it; this stand-in mirrors that swallowing so a
    // test that reached for it by mistake would be obvious.
    email: async () => undefined,
  }),
}));
vi.mock("@workspace/resupply-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/resupply-email")>()),
  createSendgridClient: sendgridMock,
}));
vi.mock("../../lib/company-info", () => ({
  getCompanyInfo: async () => ({
    name: "Acme Sleep Supply",
    legalName: "Acme Sleep Supply LLC",
  }),
}));
vi.mock("../../lib/tenant-branding", () => ({
  invalidateBrandingCache: vi.fn(),
  resolveTenantBaseUrl: async () => "https://acmesleep.com",
}));

import tenantsRouter from "./tenants";

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter);
  return app;
}

/** The tenant-exists lookup every request performs first. */
function stageTenantFound() {
  stageSupabaseResponse("organizations", "select", {
    data: { id: TENANT, name: "Acme Sleep Supply" },
  });
}

function stageAdminRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "admin-1",
    email_lower: "owner@acmesleep.com",
    role: "admin",
    status: "pending",
    display_name: null,
    last_login_at: null,
    invited_at: "2026-08-18T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
  sendgridMock.mockReset();
  sendgridMock.mockReturnValue({
    sendEmail: vi.fn().mockResolvedValue(undefined),
  });
  inviteMock.mockReset();
  inviteMock.mockResolvedValue({
    authUserId: "auth-1",
    emailSent: true,
    inviteLink: "https://acmesleep.com/admin/reset-password?token=raw",
    signInReady: false,
  });
});

describe("POST /platform/tenants/:id/admins", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });
    expect(res.status).toBe(401);
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("400s a malformed tenant id without touching auth state", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    const res = await request(makeApp())
      .post("/platform/tenants/not-a-uuid/admins")
      .send({ email: "owner@acmesleep.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_tenant_id");
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("400s an invalid email", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_admin");
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("404s an unknown tenant BEFORE creating any auth user", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("tenant_not_found");
    // The whole point: a typo'd org id must not leave an orphan identity.
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("creates the admin and sends an invite email by default", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: stageAdminRow() });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "Owner@AcmeSleep.com", displayName: "Dana" });

    expect(res.status).toBe(201);
    expect(res.body.admin.email).toBe("owner@acmesleep.com");
    expect(res.body.emailSent).toBe(true);
    expect(res.body.signInReady).toBe(false);
    // A delivered invite link lives in the recipient's inbox, not here.
    expect(res.body.inviteLink).toBeNull();

    const args = inviteMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.emailLower).toBe("owner@acmesleep.com");
    expect(args.role).toBe("admin");
    expect(args.uiPathPrefix).toBe("/admin");
    // Branded + hosted as the TARGET tenant, not the platform — a
    // CareMetric-branded email for an Acme login reads as a phish.
    expect(args.productName).toBe("Acme Sleep Supply");
    expect(args.publicBaseUrl).toBe("https://acmesleep.com");
    expect(args.initialPassword).toBeUndefined();
  });

  it("provisions a sign-in-ready account when the operator sets a password", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    inviteMock.mockResolvedValue({
      authUserId: "auth-1",
      emailSent: false,
      inviteLink: null,
      signInReady: true,
    });
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", {
      data: stageAdminRow({ status: "active" }),
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({
        email: "owner@acmesleep.com",
        initialPassword: "correct-horse-battery",
      });

    expect(res.status).toBe(201);
    expect(res.body.signInReady).toBe(true);
    expect(res.body.emailSent).toBe(false);
    expect(res.body.admin.status).toBe("active");
    const args = inviteMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.initialPassword).toBe("correct-horse-battery");
  });

  it("rejects a password under the shared 12-character floor", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com", initialPassword: "short" });
    expect(res.status).toBe(400);
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("surfaces a policy-rejected password as a fixable 422", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    inviteMock.mockRejectedValue(
      new Error("initialPassword: password is too common"),
    );
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({
        email: "owner@acmesleep.com",
        initialPassword: "passwordpassword",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("weak_initial_password");
    expect(res.body.message).toBe("password is too common");
  });

  it("refuses an email that already belongs to another tenant", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", {
      data: {
        id: "admin-9",
        org_id: OTHER_TENANT,
        role: "admin",
        status: "active",
        auth_user_id: "auth-9",
        display_name: null,
      },
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email_belongs_to_another_tenant");
    // email_lower is globally unique — proceeding would mutate the OTHER
    // tenant's identity row and mint them a live reset token.
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("refuses an already-active member of this tenant", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", {
      data: {
        id: "admin-1",
        org_id: TENANT,
        role: "csr",
        status: "active",
        auth_user_id: "auth-1",
        display_name: null,
      },
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_active_member");
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("re-invites a pending member of this tenant in place", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", {
      data: {
        id: "admin-1",
        org_id: TENANT,
        role: "admin",
        status: "pending",
        auth_user_id: "auth-1",
        display_name: "Dana",
      },
    });
    stageSupabaseResponse("admin_users", "update", {
      data: stageAdminRow({ display_name: "Dana" }),
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    // 200, not 201 — the row already existed.
    expect(res.status).toBe(200);
    expect(inviteMock).toHaveBeenCalledTimes(1);
  });

  it("hands back the invite link when the email could not be sent", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    inviteMock.mockResolvedValue({
      authUserId: "auth-1",
      emailSent: false,
      inviteLink: "https://acmesleep.com/admin/reset-password?token=raw",
      signInReady: false,
    });
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: stageAdminRow() });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    // Otherwise the operator is left with an account nobody can reach.
    expect(res.status).toBe(201);
    expect(res.body.inviteLink).toContain("/admin/reset-password?token=");
  });

  it("buckets a non-admin role to the coarse agent auth role", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", {
      data: stageAdminRow({ role: "csr" }),
    });

    await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "rep@acmesleep.com", role: "csr" });

    const args = inviteMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(args.role).toBe("agent");
  });

  it("rejects an unknown role rather than silently defaulting", async () => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com", role: "superuser" });
    expect(res.status).toBe(400);
    expect(inviteMock).not.toHaveBeenCalled();
  });
});

// ── Regressions from the 2026-08-18 review ───────────────────────────

describe("POST /platform/tenants/:id/admins — delivery + rollback", () => {
  beforeEach(() => {
    mockPlatformAdmin.current = { userId: "u1", email: "ops@cm" };
  });

  it("passes a sender that PROPAGATES delivery failure", async () => {
    // The shared auth sender swallows EmailConfigError / EmailApiError and
    // resolves, which would make inviteTeamMember report emailSent=true
    // with no email sent — withholding the invite link in exactly the
    // un-configured-SendGrid case it exists for. Assert the route hands
    // inviteTeamMember a sender that throws instead.
    inviteMock.mockImplementation(
      async (_raw, deps: { email: (i: unknown) => Promise<void> }) => {
        let threw = false;
        try {
          await deps.email({
            to: "x@y.com",
            subject: "s",
            html: "h",
            text: "t",
          });
        } catch {
          threw = true;
        }
        return {
          authUserId: "auth-1",
          emailSent: !threw,
          inviteLink: "https://acmesleep.com/admin/reset-password?token=raw",
          signInReady: false,
        };
      },
    );
    sendgridMock.mockImplementation(() => {
      throw new Error("SENDGRID_API_KEY is not set");
    });
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: stageAdminRow() });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    // The whole point: the operator gets a usable link back.
    expect(res.body.inviteLink).toContain("/admin/reset-password?token=");
  });

  it("revokes the identity when the roster write fails", async () => {
    // requireAdmin's no-roster-row branch keeps the coarse auth role and
    // falls back to the SEED org — so an identity created without its
    // admin_users row is a super-admin of the wrong tenant, not an inert
    // orphan. A 500 here must not leave one behind.
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", {
      error: { message: "insert exploded", code: "XX000" },
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("admin_write_failed");
    const updates = supabaseMock.writePayloads("users", "update");
    expect(
      updates.some(
        (payload) =>
          (payload as { status?: string } | undefined)?.status === "revoked",
      ),
      "expected the orphaned identity to be revoked",
    ).toBe(true);
  });

  it("refuses to re-invite someone whose identity is already verified", async () => {
    // admin_users.status is NOT the acceptance signal — reset-password
    // verifies the AUTH row and never touches the roster. Trusting the
    // roster status would mint a fresh live reset token for an active
    // admin and silently rewrite their role.
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", {
      data: {
        id: "admin-1",
        org_id: TENANT,
        role: "admin",
        status: "pending",
        auth_user_id: "auth-1",
        display_name: null,
      },
    });
    stageSupabaseResponse("users", "select", {
      data: { email_verified_at: "2026-08-01T00:00:00Z" },
    });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_active_member");
    expect(inviteMock).not.toHaveBeenCalled();
  });

  it("still allows a re-invite when the identity was never verified", async () => {
    stageTenantFound();
    stageSupabaseResponse("admin_users", "select", {
      data: {
        id: "admin-1",
        org_id: TENANT,
        role: "admin",
        status: "pending",
        auth_user_id: "auth-1",
        display_name: "Dana",
      },
    });
    stageSupabaseResponse("users", "select", {
      data: { email_verified_at: null },
    });
    stageSupabaseResponse("admin_users", "update", { data: stageAdminRow() });

    const res = await request(makeApp())
      .post(`/platform/tenants/${TENANT}/admins`)
      .send({ email: "owner@acmesleep.com" });

    expect(res.status).toBe(200);
    expect(inviteMock).toHaveBeenCalledTimes(1);
  });
});
