// Direct tests for makeRequireSession / makeRequireRole. The router
// test exercises these end-to-end already; this file pins the
// branch behavior (locked user, expired session, role gating) at
// a smaller scope.

import { createHash } from "node:crypto";

import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../cookies";
import { readAuthEnv } from "../env";
import { makeMemoryRepo, seedUserWithPassword } from "../test-helpers";
import { issueToken } from "../token";

import { makeRequireRole, makeRequireSession } from "./middleware";
import type { AuthDeps } from "./types";

function harness() {
  const repo = makeMemoryRepo();
  const env = readAuthEnv({
    AUTH_PROVIDER: "in_house",
  });
  const deps: AuthDeps = {
    env,
    repo,
    audit: () => {},
    email: () => {},
    publicBaseUrl: "https://example.test",
    secureCookies: false,
  };
  return { repo, deps };
}

describe("requireSession", () => {
  it("401 when there's no cookie", async () => {
    const { deps } = harness();
    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app).get("/protected");
    expect(r.status).toBe(401);
  });

  it("401 when the cookie value is malformed", async () => {
    const { deps } = harness();
    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=not-a-real-token`);
    expect(r.status).toBe(401);
  });

  it("401 when the session has expired", async () => {
    const { repo, deps } = harness();
    await seedUserWithPassword(repo, {
      id: "u_e",
      emailLower: "e@example.com",
      password: "p",
    });
    const tok = issueToken();
    await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_e",
      expiresAt: new Date(Date.now() - 1000),
      ip: null,
      userAgentHash: null,
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`);
    expect(r.status).toBe(401);
  });

  it("401 when the user is locked even with a valid session", async () => {
    const { repo, deps } = harness();
    await seedUserWithPassword(repo, {
      id: "u_l",
      emailLower: "l@example.com",
      status: "locked",
      password: "p",
    });
    const tok = issueToken();
    await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_l",
      expiresAt: new Date(Date.now() + 60_000),
      ip: null,
      userAgentHash: null,
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`);
    expect(r.status).toBe(401);
  });

  it("attaches authUser and slides expiry on success", async () => {
    const { repo, deps } = harness();
    await seedUserWithPassword(repo, {
      id: "u_a",
      emailLower: "a@example.com",
      password: "p",
    });
    const tok = issueToken();
    const before = new Date(Date.now() + 60_000); // expires soon
    const inserted = await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_a",
      expiresAt: before,
      ip: null,
      userAgentHash: null,
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (req, res) => {
      res.json({ id: req.authUser?.id, sid: req.authSessionId });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`);
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("u_a");
    expect(r.body.sid).toBe(inserted.id);

    // Sliding expiry advanced.
    const refreshed = repo.__sessions().find((s) => s.id === inserted.id);
    expect(refreshed!.expiresAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("re-issues the session + csrf cookies when the expiry slides", async () => {
    const { repo, deps } = harness();
    await seedUserWithPassword(repo, {
      id: "u_c",
      emailLower: "c@example.com",
      password: "p",
    });
    const tok = issueToken();
    await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_c",
      expiresAt: new Date(Date.now() + 60_000), // expires soon → slides
      ip: null,
      userAgentHash: null,
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}; pf_csrf=csrfval`);
    expect(r.status).toBe(200);

    // Both cookies re-issued with a Max-Age that matches the slid DB
    // expiry (≈ ttlDays = 14 days), so the browser keeps them alive
    // as long as the server-side session — the documented sliding
    // behavior. Without this the cookie dies at the fixed Max-Age
    // stamped at sign-in even though the DB row is still valid.
    const setCookies = (r.headers["set-cookie"] ?? []) as unknown as string[];
    const sess = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    const csrf = setCookies.find((c) => c.startsWith("pf_csrf="));
    expect(sess).toBeDefined();
    expect(csrf).toBeDefined();
    const maxAge = Number(/Max-Age=(\d+)/.exec(sess!)?.[1]);
    expect(maxAge).toBeGreaterThan(13 * 24 * 60 * 60);
    expect(sess).toContain(tok.raw);
    expect(csrf).toContain("csrfval");
  });

  it("does NOT set cookies when the expiry does not move", async () => {
    const { repo, deps } = harness();
    await seedUserWithPassword(repo, {
      id: "u_n",
      emailLower: "n@example.com",
      password: "p",
    });
    const tok = issueToken();
    // Already at the full ttl window → slideExpiry is a no-op.
    await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_n",
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000 + 60_000),
      ip: null,
      userAgentHash: null,
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`);
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("fires the soft UA-mismatch observer but still admits the request", async () => {
    const { repo, deps } = harness();
    const mismatches: Array<{ userId: string; sessionId: string }> = [];
    deps.onSessionUserAgentMismatch = (info) => mismatches.push(info);
    await seedUserWithPassword(repo, {
      id: "u_ua",
      emailLower: "ua@example.com",
      password: "p",
    });
    const tok = issueToken();
    const inserted = await repo.insertSession({
      tokenHash: tok.hash,
      userId: "u_ua",
      expiresAt: new Date(Date.now() + 60_000),
      ip: null,
      // Hash captured at "sign-in" for a DIFFERENT browser than the
      // one making the request below.
      userAgentHash: createHash("sha256").update("BrowserA/1.0").digest(),
    });

    const app = express();
    app.get("/protected", makeRequireSession(deps), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`)
      .set("User-Agent", "BrowserB/2.0");
    // Soft signal: observed, never blocked.
    expect(r.status).toBe(200);
    expect(mismatches).toEqual([{ userId: "u_ua", sessionId: inserted.id }]);

    // Matching UA stays silent.
    const r2 = await supertest(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE}=${tok.raw}`)
      .set("User-Agent", "BrowserA/1.0");
    expect(r2.status).toBe(200);
    expect(mismatches).toHaveLength(1);
  });
});

describe("requireRole", () => {
  function appWith(userRole: "customer" | "agent" | "admin") {
    const { repo, deps } = harness();
    repo.__putUser({
      id: "u",
      emailLower: "u@example.com",
      displayName: null,
      role: userRole,
      status: "active",
      emailVerifiedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const app = express();
    app.use((req, _res, next) => {
      req.authUser = {
        id: "u",
        emailLower: "u@example.com",
        displayName: null,
        role: userRole,
        status: "active",
        emailVerifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      next();
    });
    return { app, deps };
  }

  it("admin role admits an admin", async () => {
    const { app } = appWith("admin");
    app.get("/x", makeRequireRole("admin"), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app).get("/x");
    expect(r.status).toBe(200);
  });

  it("admin role rejects an agent", async () => {
    const { app } = appWith("agent");
    app.get("/x", makeRequireRole("admin"), (_req, res) => {
      res.json({ ok: true });
    });
    const r = await supertest(app).get("/x");
    expect(r.status).toBe(403);
  });

  it("agent role admits both agent and admin", async () => {
    for (const role of ["agent", "admin"] as const) {
      const { app } = appWith(role);
      app.get("/x", makeRequireRole("agent"), (_req, res) => {
        res.json({ ok: true });
      });
      const r = await supertest(app).get("/x");
      expect(r.status).toBe(200);
    }
  });

  it("customer is rejected by both admin and agent gates", async () => {
    for (const required of ["admin", "agent"] as const) {
      const { app } = appWith("customer");
      app.get("/x", makeRequireRole(required), (_req, res) => {
        res.json({ ok: true });
      });
      const r = await supertest(app).get("/x");
      expect(r.status).toBe(403);
    }
  });
});
