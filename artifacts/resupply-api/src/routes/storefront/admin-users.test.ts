// Integration tests verifying CSRF enforcement on the storefront admin-user
// management routes (P1.3).
//
// What these tests cover:
//   * Every mutating route (POST, PATCH, DELETE) now has `requireCsrf` in
//     its middleware chain. Each test confirms that a missing or mismatched
//     CSRF token results in a 403 response BEFORE the handler body executes.
//   * The `requireAdminOnly` gate is bypassed via vi.mock so that the tests
//     isolate the CSRF behaviour without needing a real session / DB.
//
// What these tests deliberately DON'T cover:
//   * The handler logic itself (invite flow, role-change, revocation) — that
//     is pre-existing behaviour unaffected by this PR.
//   * GET /admin/users — read-only; CSRF is only applied to state-changing
//     routes.

import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must appear before the import under test.
// ---------------------------------------------------------------------------

// Bypass requireAdminOnly so tests reach the CSRF check without needing a
// real session. requireAdmin is used transitively through requireAdminOnly.
vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdminOnly: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Suppress the pino logger that would otherwise try to write to stdout.
vi.mock("../../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Stub out auth-deps — requireAdminOnly is mocked above, but the module is
// imported at load time, so we need a safe stub here.
vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => {
    throw new Error("test: getAuthDeps should not be called in CSRF tests");
  },
}));

// Stub the Supabase client so the handler body never hits a real DB. The
// CSRF check fires before the handler, so for the 403-path tests these stubs
// are never invoked. They prevent import-time failures on the module.
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
        insert: async () => ({ data: null, error: null }),
        update: async () => ({ data: null, error: null }),
      }),
    }),
  }),
}));

// Stub auth helpers so that the import of admin-users.ts succeeds regardless
// of whether the real @workspace/resupply-auth package resolves anything that
// touches the network or filesystem.
vi.mock("@workspace/resupply-auth", async (importOriginal) => {
  // Keep the real checkCsrf / readCookie / SESSION_COOKIE so that
  // requireCsrf (the code under test) works correctly.
  const real = await importOriginal<typeof import("@workspace/resupply-auth")>();
  return {
    ...real,
    inviteTeamMember: vi.fn(),
    revokeTeamMember: vi.fn(),
    updateTeamMemberRole: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Import the router under test (after mocks are registered).
// ---------------------------------------------------------------------------
import adminUsersRouter from "./admin-users";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(adminUsersRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cookie + header that satisfy the double-submit check. */
const CSRF_TOKEN = "test-csrf-token-abc123";
const CSRF_COOKIE = `pf_csrf=${CSRF_TOKEN}`;

describe("POST /admin/users/invite — CSRF enforcement", () => {
  it("returns 403 csrf_failed when the X-PF-CSRF header is absent", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .set("Cookie", CSRF_COOKIE)
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when the pf_csrf cookie is absent", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .set("x-pf-csrf", CSRF_TOKEN)
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when cookie and header values don't match", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .set("Cookie", "pf_csrf=value-A")
      .set("x-pf-csrf", "value-B")
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when neither cookie nor header is present", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the reason in the 403 body", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .set("Cookie", CSRF_COOKIE)
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeUndefined();
  });

  it("includes a human-readable message in the 403 body", async () => {
    const res = await request(makeApp())
      .post("/admin/users/invite")
      .send({ email: "new@example.com", role: "agent" });

    expect(res.status).toBe(403);
    expect(typeof res.body.message).toBe("string");
    expect(res.body.message.length).toBeGreaterThan(0);
  });
});

describe("PATCH /admin/users/:userId/role — CSRF enforcement", () => {
  it("returns 403 csrf_failed when the CSRF header is missing", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/user-123/role")
      .set("Cookie", CSRF_COOKIE)
      .send({ role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when both cookie and header are absent", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/user-123/role")
      .send({ role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when values mismatch", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/user-123/role")
      .set("Cookie", "pf_csrf=cookie-val")
      .set("x-pf-csrf", "different-val")
      .send({ role: "admin" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the reason in the 403 body", async () => {
    const res = await request(makeApp())
      .patch("/admin/users/user-123/role")
      .set("Cookie", CSRF_COOKIE)
      .send({ role: "agent" });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeUndefined();
  });
});

describe("DELETE /admin/users/:userId — CSRF enforcement", () => {
  it("returns 403 csrf_failed when the CSRF header is missing", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/user-456")
      .set("Cookie", CSRF_COOKIE);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when neither cookie nor header is set", async () => {
    const res = await request(makeApp()).delete("/admin/users/user-456");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed on a token mismatch", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/user-456")
      .set("Cookie", "pf_csrf=aaaa")
      .set("x-pf-csrf", "bbbb");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });
});

describe("DELETE /admin/users/invitations/:invId — CSRF enforcement", () => {
  it("returns 403 csrf_failed when the CSRF header is missing", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/invitations/inv-789")
      .set("Cookie", CSRF_COOKIE);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("returns 403 csrf_failed when neither cookie nor header is set", async () => {
    const res = await request(makeApp()).delete(
      "/admin/users/invitations/inv-789",
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });

  it("does not leak the reason in the 403 body", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/invitations/inv-789")
      .set("Cookie", CSRF_COOKIE);

    expect(res.status).toBe(403);
    expect(res.body.reason).toBeUndefined();
    expect(res.body.error).toBe("csrf_failed");
  });

  it("returns 403 csrf_failed on a token mismatch", async () => {
    const res = await request(makeApp())
      .delete("/admin/users/invitations/inv-789")
      .set("Cookie", "pf_csrf=token-X")
      .set("x-pf-csrf", "token-Y");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "csrf_failed" });
  });
});