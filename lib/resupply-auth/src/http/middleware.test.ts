// Direct tests for makeRequireSession / makeRequireRole. The router
// test exercises these end-to-end already; this file pins the
// branch behavior (locked user, expired session, role gating) at
// a smaller scope.

import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE } from "../cookies";
import { readAuthEnv } from "../env";
import { makeMemoryRepo, seedUserWithPassword } from "../test-helpers";
import { issueToken } from "../token";

import { makeRequireRole, makeRequireSession } from "./middleware";
import type { AuthDeps } from "./types";

const PEPPER_BASE64 = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
).toString("base64");

function harness() {
  const repo = makeMemoryRepo();
  const env = readAuthEnv({
    AUTH_PROVIDER: "in_house",
    AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
  });
  const deps: AuthDeps = {
    env,
    repo,
    audit: () => {},
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
      pepper: Buffer.from(PEPPER_BASE64, "base64"),
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
      pepper: Buffer.from(PEPPER_BASE64, "base64"),
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
      pepper: Buffer.from(PEPPER_BASE64, "base64"),
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
