// In-house pf_session cookie path on requireSignedIn /
// attachSignedIn. The Clerk path is exercised implicitly by every
// existing /shop/* route test; this file pins the new short-
// circuit behaviour added in Stage 4b.

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

const getAuthMock = vi.fn();
vi.mock("@clerk/express", () => ({
  getAuth: (...args: unknown[]) => getAuthMock(...args),
}));

let mockDeps: AuthDeps | null = null;
vi.mock("../lib/auth-deps", () => ({
  getAuthDepsOrNull: () => mockDeps,
}));

import { attachSignedIn, requireSignedIn } from "./requireSignedIn";

function makeApp(): Express {
  const app = express();
  app.get("/protected", requireSignedIn, (req, res) => {
    res.json({ ok: true, userClerkId: req.userClerkId });
  });
  app.get("/soft", attachSignedIn, (req, res) => {
    res.json({ userClerkId: req.userClerkId ?? null });
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
      provider: "in_house",
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

describe("requireSignedIn — in-house pf_session path", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    mockDeps = null;
  });

  afterEach(() => {
    mockDeps = null;
  });

  it("admits a customer via pf_session and skips Clerk", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, { id: "u_1" });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, userClerkId: "u_1" });
    expect(getAuthMock).not.toHaveBeenCalled();
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
      expect(res.body.userClerkId).toBe(id);
    }
  });

  it("falls through to Clerk when the cookie is missing", async () => {
    const { deps } = buildDeps();
    mockDeps = deps;
    getAuthMock.mockReturnValue({ userId: "clerk_legacy" });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(200);
    expect(res.body.userClerkId).toBe("clerk_legacy");
    expect(getAuthMock).toHaveBeenCalled();
  });

  it("falls through to Clerk when the session is expired", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, {
      id: "u_x",
      expiresAt: new Date(Date.now() - 1000),
    });
    getAuthMock.mockReturnValue({ userId: "clerk_legacy" });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.userClerkId).toBe("clerk_legacy");
  });

  it("falls through to Clerk when the user is locked", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, {
      id: "u_locked",
      status: "locked",
    });
    getAuthMock.mockReturnValue({ userId: "clerk_legacy" });

    const res = await request(makeApp())
      .get("/protected")
      .set("Cookie", cookie);

    expect(res.body.userClerkId).toBe("clerk_legacy");
  });

  it("returns 401 when neither path identifies a user", async () => {
    mockDeps = null;
    getAuthMock.mockReturnValue({ userId: null });

    const res = await request(makeApp()).get("/protected");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "sign_in_required" });
  });
});

describe("attachSignedIn — soft variant", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    mockDeps = null;
  });

  it("attaches userClerkId when the in-house cookie is valid", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, { id: "u_2" });

    const res = await request(makeApp()).get("/soft").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userClerkId: "u_2" });
  });

  it("returns null userClerkId when neither path sees a session (no error)", async () => {
    mockDeps = null;
    getAuthMock.mockReturnValue({ userId: null });

    const res = await request(makeApp()).get("/soft");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userClerkId: null });
  });

  it("prefers the in-house cookie over a Clerk session when both exist", async () => {
    const { deps, repo } = buildDeps();
    mockDeps = deps;
    const { cookie } = await seedSignedIn(repo, { id: "u_local" });
    getAuthMock.mockReturnValue({ userId: "clerk_legacy" });

    const res = await request(makeApp()).get("/soft").set("Cookie", cookie);

    expect(res.body).toEqual({ userClerkId: "u_local" });
  });
});
