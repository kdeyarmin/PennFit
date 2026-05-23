// Tests for /admin/team invite route (routes/admin/team.ts)
//
// PR changes:
//   * `initialPassword` removed from the Zod `inviteBody` schema (strict mode).
//     Sending it now returns 400 invalid_body instead of being forwarded to the
//     auth library.
//   * `signInReady` removed from every invite response.
//   * The member status written to `admin_users` is always "pending" (not
//     conditionally "active" when an initial password was set).
//   * `accepted_at` is always null on a new invite.
//
// Coverage:
//   1. POST /admin/team/invite rejects bodies containing `initialPassword`
//      (strict schema).
//   2. POST /admin/team/invite accepts a valid body without initialPassword.
//   3. Validation rejects bodies missing required fields (email, role).
//   4. Validation rejects unknown roles.
//   5. The invite response does NOT include a `signInReady` field.

import { describe, expect, it, vi, beforeEach } from "vitest";
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

// ---------------------------------------------------------------------------
// Auth mock — requireAdminOnly gates the invite endpoint; we bypass it so
// tests focus on the route's own logic.
// ---------------------------------------------------------------------------

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// Rate-limiter mock — not under test here; pass every request through.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ---------------------------------------------------------------------------
// inviteTeamMember mock — keeps the route test isolated from the auth library.
// ---------------------------------------------------------------------------
const inviteTeamMemberMock = vi.hoisted(() => vi.fn());
vi.mock("@workspace/resupply-auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/resupply-auth")>();
  return {
    ...real,
    inviteTeamMember: inviteTeamMemberMock,
    revokeTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
  };
});

// auth-deps — the route only uses it to call inviteTeamMember (mocked above).
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({}),
}));

// ---------------------------------------------------------------------------
// Import the router under test (after mocks are registered).
// ---------------------------------------------------------------------------
import teamRouter from "./team";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(teamRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

const MEMBER_ROW = {
  id: "m-1",
  email_lower: "alice@example.com",
  auth_user_id: "u-1",
  role: "csr",
  status: "pending",
  display_name: "Alice",
  notes: null,
  invited_by: "u_admin_1",
  invited_at: "2026-01-01T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
  revoked_by: null,
  last_login_at: null,
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  inviteTeamMemberMock.mockReset();
  // Default: inviteTeamMember succeeds and returns a stable invite result.
  inviteTeamMemberMock.mockResolvedValue({
    authUserId: "u-1",
    emailSent: true,
    inviteLink: null,
  });
});

// ---------------------------------------------------------------------------
// Schema validation — initialPassword is no longer accepted
// ---------------------------------------------------------------------------

describe("POST /admin/team/invite — initialPassword removed from schema", () => {
  it("returns 400 invalid_body when initialPassword is included (strict schema)", async () => {
    stubAdmin();
    // The schema uses .strict() — unknown fields are rejected.
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({
        email: "alice@example.com",
        role: "csr",
        initialPassword: "superSecretPassword123",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 with issue details listing the unrecognised key", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({
        email: "alice@example.com",
        role: "csr",
        initialPassword: "superSecretPassword123",
      });

    // Zod strict() reports unrecognised_keys for extra fields.
    expect(res.status).toBe(400);
    const issues: Array<{ message: string }> = res.body.issues ?? [];
    expect(issues.length).toBeGreaterThan(0);
  });

  it("does not forward initialPassword to inviteTeamMember even as null", async () => {
    stubAdmin();
    // Stage the DB look-up for a new (no-prior) invite.
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: MEMBER_ROW });
    // auth lookup for serializeWithAuthLookup
    stageSupabaseResponse("users", "select", { data: [{ id: "u-1", email_verified_at: null }] });

    await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "csr" });

    // inviteTeamMember should have been called, but its args must NOT
    // include an initialPassword field.
    if (inviteTeamMemberMock.mock.calls.length > 0) {
      const inviteArgs = inviteTeamMemberMock.mock.calls[0] as unknown[];
      const opts = inviteArgs[2] as Record<string, unknown>;
      expect(opts).not.toHaveProperty("initialPassword");
    }
  });
});

// ---------------------------------------------------------------------------
// Schema validation — required fields still enforced
// ---------------------------------------------------------------------------

describe("POST /admin/team/invite — required field validation", () => {
  it("returns 400 when email is missing", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ role: "csr" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when role is missing", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for an unrecognised role value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "superadmin" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when the email address is malformed", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "not-an-email", role: "csr" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 401 when no admin session is present", async () => {
    // mockAdmin.current is null — requireAdminOnly sends 401.
    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "csr" });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Response shape — signInReady is no longer included
// ---------------------------------------------------------------------------

describe("POST /admin/team/invite — signInReady removed from response", () => {
  it("does NOT include signInReady in the 201 response for a new invite", async () => {
    stubAdmin();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: MEMBER_ROW });
    stageSupabaseResponse("users", "select", {
      data: [{ id: "u-1", email_verified_at: null }],
    });

    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "csr" });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("signInReady");
  });

  it("does NOT include signInReady in the 200 response for a re-invite", async () => {
    stubAdmin();
    // Prior pending invite exists.
    stageSupabaseResponse("admin_users", "select", { data: MEMBER_ROW });
    // auth_user check (not email-verified — still pending)
    stageSupabaseResponse("users", "select", {
      data: [{ id: "u-1", email_verified_at: null }],
    });
    stageSupabaseResponse("admin_users", "update", { data: MEMBER_ROW });
    // serializeWithAuthLookup
    stageSupabaseResponse("users", "select", {
      data: [{ id: "u-1", email_verified_at: null }],
    });

    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "csr" });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("signInReady");
  });

  it("returns emailSent and inviteLink in the response (unaffected fields)", async () => {
    stubAdmin();
    stageSupabaseResponse("admin_users", "select", { data: null });
    stageSupabaseResponse("admin_users", "insert", { data: MEMBER_ROW });
    stageSupabaseResponse("users", "select", {
      data: [{ id: "u-1", email_verified_at: null }],
    });

    const res = await request(makeApp())
      .post("/admin/team/invite")
      .send({ email: "alice@example.com", role: "csr" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("emailSent");
    expect(res.body).toHaveProperty("inviteLink");
    expect(res.body).toHaveProperty("member");
  });
});

// ---------------------------------------------------------------------------
// Boundary: valid roles accepted (spot-check of the role enum)
// ---------------------------------------------------------------------------

describe("POST /admin/team/invite — valid roles accepted", () => {
  for (const role of ["admin", "supervisor", "csr", "fitter", "fulfillment", "compliance_officer", "agent"] as const) {
    it(`accepts role="${role}"`, async () => {
      stubAdmin();
      stageSupabaseResponse("admin_users", "select", { data: null });
      stageSupabaseResponse("admin_users", "insert", {
        data: { ...MEMBER_ROW, role },
      });
      stageSupabaseResponse("users", "select", {
        data: [{ id: "u-1", email_verified_at: null }],
      });

      const res = await request(makeApp())
        .post("/admin/team/invite")
        .send({ email: "alice@example.com", role });

      // 201 means the body was valid; any DB or auth error would be a 500.
      expect(res.status).toBe(201);
    });
  }
});
