// In-house pf_session cookie path on requireSignedIn /
// attachSignedIn. This is the ONLY path the middleware
// supports — a request without a valid pf_session cookie gets
// a 401 (or attachSignedIn no-ops). The tests below pin that.

import express, { type Express } from "express";
import request from "supertest";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { issueToken, type AuthDeps } from "@workspace/resupply-auth";
import {
  makeMemoryRepo,
  type MemoryRepo,
} from "@workspace/resupply-auth/test-helpers";

let mockDeps: AuthDeps | null = null;
vi.mock("../lib/auth-deps", () => ({
  // getAuthDeps always returns in production. We throw rather
  // than return null in tests so the failure mode is loud.
  getAuthDeps: () => {
    if (!mockDeps) throw new Error("test: mockDeps not set");
    return mockDeps;
  },
  getAuthDepsOrNull: () => mockDeps,
}));

import { attachSignedIn, requireSignedIn } from "./requireSignedIn";

function makeApp(): Express {
  const app = express();
  app.get("/protected", requireSignedIn, (req, res) => {
    res.json({ ok: true, userCustomerId: req.userCustomerId });
  });
  app.get("/soft", attachSignedIn, (req, res) => {
    res.json({ userCustomerId: req.userCustomerId ?? null });
  });
  return app;
}

const PEPPER = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
);

function buildDeps(): { deps: AuthDeps; repo: MemoryRepo } {
  const repo = makeMemoryRepo();
  const deps: AuthDeps = {
    env: {
      passwordPepper: PEPPER,
      sessionTtlDays: 14,
      emailTokenTtlHours: 24,
    },
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
    allowSignUp: true,
  };
  return { deps, repo };
}

async function seedSignedIn(
  repo: MemoryRepo,
  opts: {
    id: string;
    role?: "customer" | "agent" | "admin";
    status?: "active" | "locked" | "revoked";
    revokedAt?: Date | null;
    expiresAt?: Date;
  },
): Promise<{ cookie: string }> {
  repo.__putUser({
    id: opts.id,
    emailLower: `${opts.id}@example.com`,
    displayName: null,
    role: opts.role ?? "customer",
    status: opts.status ?? "active",
    emailVerifiedAt: new Date(),
    createdAt: new Date(),
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

describe("requireSignedIn — in-house pf_session path (Stage 5a)", () => {
  beforeEach(() => {
    mockDeps = null;
  });

  afterEach(() => {
    mockDeps = null;
  });

  it("admits a customer via pf_session", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, { id: "u_1" });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, userCustomerId: "u_1" });
  });

  it("admits agent / admin staff who happen to also be shop customers", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    for (const role of ["agent", "admin"] as const) {
      const id = `u_${role}`;
      const { cookie } = await seedSignedIn(repo, { id, role });
      const res = await request(makeApp())
        .get("/protected")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.userCustomerId).toBe(id);
    }
  });

  it("returns 401 when the cookie is missing", async () => {
    const { deps } = buildDeps();
    mockDeps = deps;
    const res = await request(makeApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "sign_in_required" });
  });

  it("returns 401 when the session is expired", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, {
      id: "u_x",
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the session has been revoked", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, {
      id: "u_rev",
      revokedAt: new Date(),
    });
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the user is locked", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, {
      id: "u_locked",
      status: "locked",
    });
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie is malformed", async () => {
    const { deps } = buildDeps();
    mockDeps = deps;
    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", "pf_session=not-a-real-base64url-token");
    expect(res.status).toBe(401);
  });
});

describe("attachSignedIn — soft variant (Stage 5a)", () => {
  beforeEach(() => {
    mockDeps = null;
  });

  it("attaches userCustomerId when the in-house cookie is valid", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, { id: "u_2" });

    const res = await request(makeApp()).get("/soft").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userCustomerId: "u_2" });
  });

  it("returns null userCustomerId when no session is present", async () => {
    const { deps } = buildDeps();
    mockDeps = deps;
    const res = await request(makeApp()).get("/soft");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userCustomerId: null });
  });

  it("returns null userCustomerId for a malformed cookie (no error)", async () => {
    const { deps } = buildDeps();
    mockDeps = deps;
    const res = await request(makeApp())
      .get("/soft")
      .set("Cookie", "pf_session=garbage");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userCustomerId: null });
  });
});
