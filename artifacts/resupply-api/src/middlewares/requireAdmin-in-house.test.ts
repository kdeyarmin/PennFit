// Tests for the in-house pf_session cookie path on requireAdmin —
// the only path the middleware supports.

import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPassword,
  issueToken,
  type AuthDeps,
} from "@workspace/resupply-auth";
import {
  makeMemoryRepo,
  type MemoryRepo,
} from "@workspace/resupply-auth/test-helpers";

// Mock the auth-deps module so we can inject an in-memory repo
// and drive role / status / session state from each test.
let mockDeps: AuthDeps | null = null;
vi.mock("../lib/auth-deps", () => ({
  getAuthDeps: () => {
    if (!mockDeps) throw new Error("test: mockDeps not set");
    return mockDeps;
  },
}));

// Mock the Supabase client behind the granular admin_users role
// lookup. Default: lookup succeeds with NO row — the legacy
// pre-Phase-A shape, which falls back to the coarse role. Tests
// override `mockAdminUsersLookup` to exercise the granular-role
// attach and the fail-closed paths (P2-19).
type AdminUsersLookupResult =
  | {
      data: { role: string; location_id: string | null } | null;
      error: { message: string } | null;
    }
  | "throw";
let mockAdminUsersLookup: AdminUsersLookupResult = { data: null, error: null };
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => {
                if (mockAdminUsersLookup === "throw") {
                  throw new Error("admin_users lookup blew up");
                }
                return mockAdminUsersLookup;
              },
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { requireAdmin, requireAdminOnly } from "./requireAdmin";

function makeApp(): Express {
  const app = express();
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1_000,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.get("/protected", limiter, requireAdmin, (req, res) => {
    res.json({
      ok: true,
      adminEmail: req.adminEmail,
      adminUserId: req.adminUserId,
      adminRole: req.adminRole,
      adminGranularRole: req.adminGranularRole,
    });
  });
  app.get("/admin-only", limiter, requireAdminOnly, (req, res) => {
    res.json({ ok: true, adminRole: req.adminRole });
  });
  // State-changing route to exercise the in-gate CSRF enforcement.
  app.post("/protected", limiter, requireAdmin, (req, res) => {
    res.json({ ok: true, adminEmail: req.adminEmail });
  });
  return app;
}

async function buildDepsWithRepo(): Promise<{
  deps: AuthDeps;
  repo: MemoryRepo;
}> {
  const repo = makeMemoryRepo();
  const deps: AuthDeps = {
    env: {
      sessionTtlDays: 14,
      emailTokenTtlHours: 24,
    },
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    allowSignUp: false,
  };
  return { deps, repo };
}

/**
 * Insert a user + active session and return the cookie value to
 * send. Optional opts tune the role / status of the user and the
 * expiry of the session.
 */
async function seedSignedInUser(
  repo: MemoryRepo,
  opts: {
    id: string;
    email: string;
    role: "admin" | "agent" | "customer";
    status?: "active" | "locked" | "revoked" | "invited";
    expiresAt?: Date;
    revokedAt?: Date | null;
  },
): Promise<{ cookie: string }> {
  // Plant the user directly via the repo's escape hatch — bypassing
  // the password+verify flow we'd use in real life keeps these
  // tests scoped to requireAdmin's behavior.
  repo.__putUser({
    id: opts.id,
    emailLower: opts.email.toLowerCase(),
    displayName: null,
    role: opts.role,
    status: opts.status ?? "active",
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // We don't need a password credential for any of these tests —
  // the middleware doesn't read it. Plant one anyway so the user
  // looks complete (would never sign in without one).
  const hash = await hashPassword("placeholder", {
    memoryCost: 1024,
    timeCost: 1,
    parallelism: 1,
  });
  repo.__putCredential({
    userId: opts.id,
    passwordHash: hash,
    algo: "argon2id-v1",
    mustChange: false,
    setByAdminAt: null,
    updatedAt: new Date(),
  });
  const tok = issueToken();
  const session = await repo.insertSession({
    tokenHash: tok.hash,
    userId: opts.id,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 60_000),
    ip: null,
    userAgentHash: null,
  });
  if (opts.revokedAt) {
    await repo.revokeSession(session.id, opts.revokedAt);
  }
  return { cookie: `pf_session=${tok.raw}` };
}

describe("requireAdmin — in-house pf_session cookie path", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mockDeps = null;
    mockAdminUsersLookup = { data: null, error: null };
    originalEnv = {
      RESUPPLY_ADMIN_EMAILS: process.env.RESUPPLY_ADMIN_EMAILS,
      NODE_ENV: process.env.NODE_ENV,
    };
    delete process.env.RESUPPLY_ADMIN_EMAILS;
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("admits an active admin via pf_session cookie", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_admin",
      email: "alice@example.com",
      role: "admin",
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      adminEmail: "alice@example.com",
      adminUserId: "u_admin",
      adminRole: "admin",
      adminGranularRole: "admin",
    });
  });

  it("admits an agent via pf_session cookie", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_agent",
      email: "bob@example.com",
      role: "agent",
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.adminRole).toBe("agent");
  });

  it("requireAdminOnly rejects an in-house agent with 403", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_agent2",
      email: "csr@example.com",
      role: "agent",
    });

    const res = await request(makeApp())
      .get("/admin-only")
      .set("Cookie", cookie);

    expect(res.status).toBe(403);
  });

  it("rejects a customer-role user with 401 (dashboard is staff-only)", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_cust",
      email: "shopper@example.com",
      role: "customer",
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("returns 401 when the session is expired", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_x",
      email: "x@example.com",
      role: "admin",
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("returns 401 when the session has been revoked", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_rev",
      email: "rev@example.com",
      role: "admin",
      revokedAt: new Date(),
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("returns 401 when the user is locked", async () => {
    const { deps, repo } = await buildDepsWithRepo();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_lock",
      email: "l@example.com",
      role: "admin",
      status: "locked",
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie value is malformed", async () => {
    const { deps } = await buildDepsWithRepo();
    mockDeps = deps;

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", "pf_session=not-a-real-base64url-token");

    expect(res.status).toBe(401);
  });

  it("returns 401 when the session cookie value is unrecognised", async () => {
    const { deps } = await buildDepsWithRepo();
    mockDeps = deps;

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", "pf_session=anything");

    expect(res.status).toBe(401);
  });

  it("returns 401 when no cookie is present", async () => {
    const { deps } = await buildDepsWithRepo();
    mockDeps = deps;

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(401);
  });

  // ── Granular admin_users role lookup (Phase A / P2-19) ─────────────
  describe("granular role lookup", () => {
    it("attaches the granular role when an admin_users row exists", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      mockAdminUsersLookup = {
        data: { role: "csr", location_id: null },
        error: null,
      };
      const { cookie } = await seedSignedInUser(repo, {
        id: "u_granular",
        email: "g@example.com",
        role: "admin",
      });

      const res = await request(makeApp())
        .get("/protected")
        .set("Cookie", cookie);

      // Coarse role still admits; the granular role (csr) is what
      // requirePermission would consult.
      expect(res.status).toBe(200);
      expect(res.body.adminRole).toBe("admin");
      expect(res.body.adminGranularRole).toBe("csr");
    });

    it("falls back to the coarse role when NO admin_users row exists (legacy)", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      mockAdminUsersLookup = { data: null, error: null };
      const { cookie } = await seedSignedInUser(repo, {
        id: "u_legacy",
        email: "legacy@example.com",
        role: "admin",
      });

      const res = await request(makeApp())
        .get("/protected")
        .set("Cookie", cookie);

      expect(res.status).toBe(200);
    });

    it("fails closed (401) when the admin_users lookup returns a PostgREST error", async () => {
      // Regression for app-review 2026-06-10 P2-19: falling back to
      // the coarse role on a lookup ERROR would let a deliberately
      // downgraded staffer regain full admin during any admin_users
      // read hiccup.
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      mockAdminUsersLookup = {
        data: null,
        error: { message: "PostgREST unavailable" },
      };
      const { cookie } = await seedSignedInUser(repo, {
        id: "u_err",
        email: "err@example.com",
        role: "admin",
      });

      const res = await request(makeApp())
        .get("/protected")
        .set("Cookie", cookie);

      expect(res.status).toBe(401);
    });

    it("fails closed (401) when the admin_users lookup throws", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      mockAdminUsersLookup = "throw";
      const { cookie } = await seedSignedInUser(repo, {
        id: "u_throw",
        email: "throw@example.com",
        role: "admin",
      });

      const res = await request(makeApp())
        .get("/protected")
        .set("Cookie", cookie);

      expect(res.status).toBe(401);
    });
  });

  // ── CSRF enforcement on state-changing admin requests ──────────────
  // requireAdmin double-submit-CSRF-gates every non-safe method, so an
  // admin route mounted OUTSIDE the /api/admin path prefix (which the
  // app-level requireCsrfOnAdminMutations gate matches) is still
  // protected. Auth resolves first, so an unauthenticated mutation is a
  // clean 401, not a 403.
  describe("CSRF on state-changing requests", () => {
    it("admits a POST with matching pf_csrf cookie + X-PF-CSRF header", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      const { cookie } = await seedSignedInUser(repo, {
        id: "u-csrf-ok",
        email: "admin@example.test",
        role: "admin",
      });

      const res = await request(makeApp())
        .post("/protected")
        .set("Cookie", `${cookie}; pf_csrf=tok-123`)
        .set("X-PF-CSRF", "tok-123");

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects a POST that omits the X-PF-CSRF header (403 csrf_failed)", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      const { cookie } = await seedSignedInUser(repo, {
        id: "u-csrf-missing",
        email: "admin@example.test",
        role: "admin",
      });

      const res = await request(makeApp())
        .post("/protected")
        .set("Cookie", `${cookie}; pf_csrf=tok-123`);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_failed");
    });

    it("rejects a POST when the cookie and header CSRF values mismatch", async () => {
      const { deps, repo } = await buildDepsWithRepo();
      mockDeps = deps;
      const { cookie } = await seedSignedInUser(repo, {
        id: "u-csrf-mismatch",
        email: "admin@example.test",
        role: "admin",
      });

      const res = await request(makeApp())
        .post("/protected")
        .set("Cookie", `${cookie}; pf_csrf=tok-123`)
        .set("X-PF-CSRF", "different-token");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("csrf_failed");
    });

    it("returns 401 (not 403) for an unauthenticated POST — auth gate runs first", async () => {
      const { deps } = await buildDepsWithRepo();
      mockDeps = deps;

      const res = await request(makeApp()).post("/protected");

      expect(res.status).toBe(401);
    });
  });
});
