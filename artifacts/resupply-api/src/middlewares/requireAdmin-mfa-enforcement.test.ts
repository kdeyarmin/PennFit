// Tests for the server-side mandatory-MFA gate in requireAdmin.
//
// When AUTH_REQUIRE_MFA_FOR_ADMINS is set, an admin/agent with NO verified
// MFA enrollment must be blocked from the admin API EXCEPT the enrollment +
// identity endpoints — so the env flag is a real gate, not just a UI banner.
// The flag is captured at module load, so we set it and dynamically import
// requireAdmin in beforeAll.

import express, { type Express } from "express";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

// admin_users lookup: a normal active admin, seed org (so the agreements gate
// is skipped — resolveSeedOrgId returns null below).
vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () => ({
    schema: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { role: "admin", location_id: null, org_id: null },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
  getOrgScopedClient: () => ({
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  }),
  resolveSeedOrgId: async () => null,
}));

// `findActiveSecret` toggles per test: null = unenrolled, object = enrolled.
let mfaSecret: { secretBase32: string; lastUsedCounter: number } | null = null;
let mfaProbeThrows = false;
const findActiveSecret = vi.fn(async () => {
  if (mfaProbeThrows) throw new Error("mfa probe blew up");
  return mfaSecret;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let requireAdmin: any;

beforeAll(async () => {
  process.env.AUTH_REQUIRE_MFA_FOR_ADMINS = "true";
  vi.resetModules();
  ({ requireAdmin } = await import("./requireAdmin"));
});

afterAll(() => {
  delete process.env.AUTH_REQUIRE_MFA_FOR_ADMINS;
});

function makeApp(): Express {
  const app = express();
  app.get("/protected", requireAdmin, (_req, res) => res.json({ ok: true }));
  app.get("/me", requireAdmin, (_req, res) =>
    res.json({ ok: true, endpoint: "me" }),
  );
  app.get("/admin/mfa/status", requireAdmin, (_req, res) =>
    res.json({ ok: true, endpoint: "mfa-status" }),
  );
  app.post("/admin/mfa/enroll/begin", requireAdmin, (_req, res) =>
    res.json({ ok: true, endpoint: "enroll" }),
  );
  return app;
}

async function seedAdmin(repo: MemoryRepo): Promise<{ cookie: string }> {
  repo.__putUser({
    id: "u_admin",
    emailLower: "admin@example.com",
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
    userId: "u_admin",
    passwordHash: hash,
    algo: "argon2id-v1",
    mustChange: false,
    setByAdminAt: null,
    updatedAt: new Date(),
  });
  const tok = issueToken();
  await repo.insertSession({
    tokenHash: tok.hash,
    userId: "u_admin",
    expiresAt: new Date(Date.now() + 60_000),
    ip: null,
    userAgentHash: null,
  });
  return { cookie: `pf_session=${tok.raw}` };
}

function buildDeps(repo: MemoryRepo): AuthDeps {
  return {
    env: { sessionTtlDays: 14, emailTokenTtlHours: 24 },
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    allowSignUp: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mfa: { findActiveSecret } as any,
  } as AuthDeps;
}

describe("requireAdmin — mandatory MFA enforcement", () => {
  let repo: MemoryRepo;

  beforeEach(async () => {
    repo = makeMemoryRepo();
    mockDeps = buildDeps(repo);
    mfaSecret = null;
    mfaProbeThrows = false;
    findActiveSecret.mockClear();
  });

  it("blocks a non-enrollment endpoint (403) when the admin has no verified MFA", async () => {
    const { cookie } = await seedAdmin(repo);
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("mfa_enrollment_required");
  });

  it("admits the same endpoint once the admin has a verified MFA secret", async () => {
    mfaSecret = { secretBase32: "ABC", lastUsedCounter: 0 };
    const { cookie } = await seedAdmin(repo);
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("allows /me through even when unenrolled (so the SPA learns it must enroll)", async () => {
    const { cookie } = await seedAdmin(repo);
    const res = await request(makeApp()).get("/me").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.endpoint).toBe("me");
  });

  it("allows the MFA status + enrollment endpoints through when unenrolled", async () => {
    const { cookie } = await seedAdmin(repo);
    const status = await request(makeApp())
      .get("/admin/mfa/status")
      .set("Cookie", cookie);
    expect(status.status).toBe(200);
    const begin = await request(makeApp())
      .post("/admin/mfa/enroll/begin")
      .set("Cookie", `${cookie}; pf_csrf=t`)
      .set("X-PF-CSRF", "t");
    expect(begin.status).toBe(200);
  });

  it("fails closed (403) when the MFA enrollment probe throws", async () => {
    mfaProbeThrows = true;
    const { cookie } = await seedAdmin(repo);
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("mfa_enrollment_required");
  });
});
