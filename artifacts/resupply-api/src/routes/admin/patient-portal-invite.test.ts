// Route tests for POST /admin/patients/:id/portal-invite (+ /resend).
//
// Focus: the patient-facing portal-invite email must be branded with the
// INVITING tenant's own identity (resolveBrandingByOrgId), never the
// hardcoded seed brand ("Penn Home Medical Supply" / "Penn Home Medical Supply"). The
// token mint, email renderer, help-doc attachments, and outbound email
// are mocked at the module boundary; the route's brand wiring is what's
// exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Rate limiter (express-rate-limit) needs no special handling, but the
// destroy-preset admin-rate-limit middleware should pass through.
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: express.Request,
      _res: express.Response,
      next: express.NextFunction,
    ) =>
      next(),
}));

const { emailMock } = vi.hoisted(() => ({ emailMock: vi.fn() }));
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({
    publicBaseUrl: "https://cmbreathe.com",
    email: emailMock,
  }),
}));

vi.mock("../../lib/help-docs", () => ({
  buildInviteHelpAttachments: vi.fn(async () => []),
}));

// Per-tenant brand resolver — stubbed so the test controls the resolved
// identity and can assert the renderer receives it.
const resolveBrandingByOrgIdMock = vi.hoisted(() =>
  vi.fn(async (_orgId?: string) => ({
    storefrontName: "Acme Sleep",
    legalName: "Acme Sleep Supply LLC",
    tagline: "",
    logoUrl: null,
  })),
);
const resolveTenantBaseUrlMock = vi.hoisted(() =>
  vi.fn(async (_orgId?: string) => "https://shop.acme.example"),
);
vi.mock("../../lib/tenant-branding", () => ({
  resolveBrandingByOrgId: resolveBrandingByOrgIdMock,
  resolveTenantBaseUrl: resolveTenantBaseUrlMock,
}));

// Keep the real exports (roleHasPermission for the auth mock) and stub
// only the token-mint + invite-email renderer the route calls.
vi.mock("@workspace/resupply-auth", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-auth")
  >("@workspace/resupply-auth");
  return {
    ...actual,
    issueToken: vi.fn(() => ({
      raw: "raw-token-123",
      hash: Buffer.from("hash"),
    })),
    bufferToHexBytea: vi.fn(() => "\\x6861736800"),
    renderPatientPortalInviteEmail: vi.fn(() => ({
      subject: "Set up your patient portal",
      html: "<p>hi</p>",
      text: "hi",
    })),
    revokeTeamMember: vi.fn(async () => undefined),
  };
});

vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import portalInviteRouter from "./patient-portal-invite";
import { renderPatientPortalInviteEmail } from "@workspace/resupply-auth";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@example.com",
  role: "admin",
};
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(portalInviteRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  vi.mocked(renderPatientPortalInviteEmail).mockClear();
  resolveBrandingByOrgIdMock.mockClear();
});

/** Stage the DB round-trips a fresh invite makes:
 *  patients read → users read (none) → users insert → patients
 *  claimed-by-other check (none) → patients update → email_tokens insert. */
function stageInviteHappyPath(): void {
  stageSupabaseResponse("patients", "select", {
    data: {
      id: PATIENT_ID,
      email: "patient@example.com",
      legal_first_name: "Sam",
      portal_auth_user_id: null,
    },
  });
  // resupply_auth.users select → no existing user for this email.
  stageSupabaseResponse("users", "select", { data: null });
  // resupply_auth.users insert → new auth user id.
  stageSupabaseResponse("users", "insert", { data: { id: "auth-user-1" } });
  // patients claimed-by-other check → none.
  stageSupabaseResponse("patients", "select", { data: null });
  // patients update (link the auth user) → ok.
  stageSupabaseResponse("patients", "update", { data: null });
  // email_tokens insert → ok.
  stageSupabaseResponse("email_tokens", "insert", { data: null });
}

describe("POST /admin/patients/:id/portal-invite", () => {
  it("401s unauthenticated", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/portal-invite`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("brands the invite email with the inviting tenant's identity, not the seed brand", async () => {
    mockAdmin.current = ADMIN;
    stageInviteHappyPath();

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/portal-invite`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // The renderer must receive the resolved tenant brand — never the
    // hardcoded "Penn Home Medical Supply" / "Penn Home Medical Supply".
    const ctx = vi.mocked(renderPatientPortalInviteEmail).mock.calls[0]![0];
    expect(ctx.productName).toBe("Acme Sleep");
    expect(ctx.signatureName).toBe("Acme Sleep Supply LLC");
    expect(ctx.productName).not.toContain("Penn Home Medical Supply");
    expect(ctx.signatureName).not.toContain("Penn Home Medical Supply");
  });
});

describe("POST /admin/patients/:id/portal-invite/resend", () => {
  it("brands the resent invite email with the inviting tenant's identity", async () => {
    mockAdmin.current = ADMIN;
    // patients read → has a pending portal auth user.
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT_ID,
        email: "patient@example.com",
        legal_first_name: "Sam",
        portal_auth_user_id: "auth-user-1",
      },
    });
    // resupply_auth.users read → pending (not yet verified).
    stageSupabaseResponse("users", "select", {
      data: {
        id: "auth-user-1",
        email_lower: "patient@example.com",
        email_verified_at: null,
      },
    });
    // email_tokens insert → ok.
    stageSupabaseResponse("email_tokens", "insert", { data: null });
    // patients update (stamp invited_at) → ok.
    stageSupabaseResponse("patients", "update", { data: null });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/portal-invite/resend`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    const ctx = vi.mocked(renderPatientPortalInviteEmail).mock.calls[0]![0];
    expect(ctx.productName).toBe("Acme Sleep");
    expect(ctx.signatureName).toBe("Acme Sleep Supply LLC");
    expect(ctx.publicBaseUrl).toBe("https://shop.acme.example");
    expect(ctx.productName).not.toContain("Penn Home Medical Supply");
  });
});
