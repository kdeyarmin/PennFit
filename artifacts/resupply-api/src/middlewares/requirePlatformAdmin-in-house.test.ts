// Tests for requirePlatformAdmin — the platform super-admin gate.
//
// Coverage:
//   * 401 when no/invalid session.
//   * 403 when the session is valid but the user is NOT in
//     platform_admins.
//   * admits (next) when the user IS a platform admin.
//   * fail-closed (401) when the platform_admins lookup errors.

import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hashPassword,
  issueToken,
  type AuthDeps,
} from "@workspace/resupply-auth";
import {
  makeMemoryRepo,
  type MemoryRepo,
} from "@workspace/resupply-auth/test-helpers";

let mockDeps: AuthDeps | null = null;
vi.mock("../lib/auth-deps", () => ({
  getAuthDeps: () => {
    if (!mockDeps) throw new Error("test: mockDeps not set");
    return mockDeps;
  },
}));

// Drive the platform_admins membership lookup per test.
type LookupResult =
  | { data: { auth_user_id: string } | null; error: { message: string } | null }
  | "throw";
let mockLookup: LookupResult = { data: null, error: null };
vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "00000000-0000-4000-8000-000000000000",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => {
                  if (mockLookup === "throw")
                    throw new Error("platform_admins lookup blew up");
                  return mockLookup;
                },
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

import { requirePlatformAdmin } from "./requirePlatformAdmin";

function makeApp(): Express {
  const app = express();
  // A limiter on the test fixture mirrors the production route (and keeps
  // the CodeQL "authorization without rate limiting" rule satisfied for
  // this throwaway test handler). High cap so it never trips in tests.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1_000,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.get("/platform/protected", limiter, requirePlatformAdmin, (req, res) => {
    res.json({ ok: true, platformAdminUserId: req.platformAdminUserId });
  });
  return app;
}

async function seedSignedInUser(
  repo: MemoryRepo,
  opts: { id: string; email: string },
): Promise<{ cookie: string }> {
  repo.__putUser({
    id: opts.id,
    emailLower: opts.email.toLowerCase(),
    displayName: null,
    role: "admin",
    status: "active",
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
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
  await repo.insertSession({
    tokenHash: tok.hash,
    userId: opts.id,
    expiresAt: new Date(Date.now() + 60_000),
    ip: null,
    userAgentHash: null,
  });
  return { cookie: `pf_session=${tok.raw}` };
}

async function buildDeps(): Promise<{ deps: AuthDeps; repo: MemoryRepo }> {
  const repo = makeMemoryRepo();
  const deps: AuthDeps = {
    env: { sessionTtlDays: 14, emailTokenTtlHours: 24 },
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    allowSignUp: false,
  };
  return { deps, repo };
}

describe("requirePlatformAdmin", () => {
  beforeEach(() => {
    mockDeps = null;
    mockLookup = { data: null, error: null };
  });

  it("401s when no cookie is present", async () => {
    const { deps } = await buildDeps();
    mockDeps = deps;
    const res = await request(makeApp()).get("/platform/protected");
    expect(res.status).toBe(401);
  });

  it("403s when the user is signed in but not a platform admin", async () => {
    const { deps, repo } = await buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_1",
      email: "tenant-admin@penn.example",
    });
    mockLookup = { data: null, error: null }; // no platform_admins row
    const res = await request(makeApp())
      .get("/platform/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
  });

  it("admits a platform admin", async () => {
    const { deps, repo } = await buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_platform",
      email: "ops@cmbreathe.example",
    });
    mockLookup = { data: { auth_user_id: "u_platform" }, error: null };
    const res = await request(makeApp())
      .get("/platform/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      platformAdminUserId: "u_platform",
    });
  });

  it("fails closed (401) when the membership lookup errors", async () => {
    const { deps, repo } = await buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedInUser(repo, {
      id: "u_2",
      email: "ops@cmbreathe.example",
    });
    mockLookup = { data: null, error: { message: "db down" } };
    const res = await request(makeApp())
      .get("/platform/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(401);
  });
});
