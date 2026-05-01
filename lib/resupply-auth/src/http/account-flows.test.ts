// End-to-end tests for the new Stage 2b handlers:
//   sign-up, verify-email, forgot-password, reset-password,
//   change-password.
//
// All driven through the makeAuthRouter factory + the in-memory
// repo. The handlers under test never touch Postgres in this
// suite; the pg-backed implementation is exercised by the
// resupply-db migration smoke + future integration suite.

import express, { type Express } from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";

import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../cookies";
import { readAuthEnv } from "../env";
import { makeMemoryRepo, seedUserWithPassword } from "../test-helpers";

import { makeAuthRouter } from "./index";
import type { AuditWriter, AuthDeps } from "./types";

const PEPPER_BASE64 = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex",
).toString("base64");
const PEPPER = Buffer.from(PEPPER_BASE64, "base64");

interface Harness {
  app: Express;
  repo: ReturnType<typeof makeMemoryRepo>;
  audit: AuditWriter & { actions: string[] };
  emails: Array<{ to: string; subject: string; html: string; text: string }>;
}

function buildHarness(overrides: Partial<AuthDeps> = {}): Harness {
  const repo = makeMemoryRepo();
  const actions: string[] = [];
  const audit: AuditWriter & { actions: string[] } = Object.assign(
    (event: { action: string }) => {
      actions.push(event.action);
    },
    { actions },
  );
  const emails: Array<{
    to: string;
    subject: string;
    html: string;
    text: string;
  }> = [];
  const env = readAuthEnv({
    AUTH_PROVIDER: "in_house",
    AUTH_PASSWORD_PEPPER: PEPPER_BASE64,
  });
  const deps: AuthDeps = {
    env,
    repo,
    audit,
    email: (input) => {
      emails.push(input);
    },
    publicBaseUrl: "https://example.test",
    allowSignUp: true,
    secureCookies: false,
    passwordHashParams: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use("/auth", makeAuthRouter(deps, { productName: "TestProduct" }));
  return { app, repo, audit, emails };
}

/**
 * Pull the raw token out of a verification or reset email. Tokens
 * always live as the URL `?token=...` parameter — encoded with
 * encodeURIComponent so we decode here.
 */
function extractEmailToken(body: string): string {
  const match = body.match(/[?&]token=([^"\s&]+)/u);
  if (!match) throw new Error(`no token in email body: ${body}`);
  return decodeURIComponent(match[1]!);
}

function getCookieValue(setCookie: unknown, name: string): string | null {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie)
    ? (setCookie as string[])
    : [String(setCookie)];
  for (const c of list) {
    const head = c.split(";")[0];
    const eq = head.indexOf("=");
    if (eq === -1) continue;
    if (head.slice(0, eq) === name) return head.slice(eq + 1);
  }
  return null;
}

// ---- sign-up ------------------------------------------------------------

describe("POST /auth/sign-up", () => {
  it("creates an invited user, sends a verification email, returns 200", async () => {
    const h = buildHarness();
    const res = await supertest(h.app).post("/auth/sign-up").send({
      email: "newbie@example.com",
      password: "correct horse battery staple",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const created = h.repo.__users().find((u) => u.emailLower === "newbie@example.com");
    expect(created).toBeDefined();
    expect(created!.status).toBe("invited");
    expect(created!.emailVerifiedAt).toBeNull();
    expect(created!.role).toBe("customer");

    expect(h.repo.__credentials()).toHaveLength(1);
    expect(h.repo.__emailTokens()).toHaveLength(1);
    expect(h.repo.__emailTokens()[0]!.purpose).toBe("signup_verify");

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.to).toBe("newbie@example.com");
    expect(h.audit.actions).toContain("auth.sign_up");
  });

  it("returns 400 when password is too short", async () => {
    const h = buildHarness();
    const res = await supertest(h.app).post("/auth/sign-up").send({
      email: "x@example.com",
      password: "short",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("returns 200 + does NOT send a second email when the address is already verified", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_existing",
      emailLower: "existing@example.com",
      password: "the existing password",
      pepper: PEPPER,
    });

    const res = await supertest(h.app).post("/auth/sign-up").send({
      email: "existing@example.com",
      password: "another correct horse battery staple",
    });
    expect(res.status).toBe(200);
    expect(h.emails).toHaveLength(0);
    expect(h.audit.actions).toContain("auth.sign_up_existing");
  });

  it("re-attaches an unverified existing account (updates password + re-issues token)", async () => {
    const h = buildHarness();
    await supertest(h.app).post("/auth/sign-up").send({
      email: "newbie@example.com",
      password: "first attempt password",
    });
    expect(h.repo.__emailTokens()).toHaveLength(1);

    const res = await supertest(h.app).post("/auth/sign-up").send({
      email: "newbie@example.com",
      password: "second attempt password",
    });
    expect(res.status).toBe(200);
    expect(h.repo.__users()).toHaveLength(1);
    expect(h.repo.__emailTokens()).toHaveLength(2);
  });

  it("404s when allowSignUp is false", async () => {
    const h = buildHarness({ allowSignUp: false });
    const res = await supertest(h.app).post("/auth/sign-up").send({
      email: "x@example.com",
      password: "correct horse battery staple",
    });
    expect(res.status).toBe(404);
  });
});

// ---- verify-email -------------------------------------------------------

describe("POST /auth/verify-email", () => {
  it("consumes a valid token, marks email_verified_at, flips invited→active", async () => {
    const h = buildHarness();
    await supertest(h.app).post("/auth/sign-up").send({
      email: "v@example.com",
      password: "correct horse battery staple",
    });
    const token = extractEmailToken(h.emails[0]!.text);

    const res = await supertest(h.app)
      .post("/auth/verify-email")
      .send({ token });
    expect(res.status).toBe(200);

    const user = h.repo
      .__users()
      .find((u) => u.emailLower === "v@example.com")!;
    expect(user.status).toBe("active");
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(h.audit.actions).toContain("auth.email_verified");
  });

  it("410s a token that's already been consumed", async () => {
    const h = buildHarness();
    await supertest(h.app).post("/auth/sign-up").send({
      email: "v@example.com",
      password: "correct horse battery staple",
    });
    const token = extractEmailToken(h.emails[0]!.text);

    await supertest(h.app).post("/auth/verify-email").send({ token });
    const second = await supertest(h.app)
      .post("/auth/verify-email")
      .send({ token });
    expect(second.status).toBe(410);
  });

  it("410s a malformed token", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .post("/auth/verify-email")
      .send({ token: "not a real token" });
    expect(res.status).toBe(410);
  });
});

// ---- forgot-password ----------------------------------------------------

describe("POST /auth/forgot-password", () => {
  it("returns 200 + sends an email when the account exists", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
      pepper: PEPPER,
    });
    const res = await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    expect(res.status).toBe(200);
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.subject).toMatch(/Reset your TestProduct password/);
  });

  it("returns 200 with no email when the account does NOT exist (no enumeration)", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "ghost@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(h.emails).toHaveLength(0);
  });

  it("returns 200 (not 400) on malformed input — same shape as success", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "not an email" });
    expect(res.status).toBe(200);
    expect(h.emails).toHaveLength(0);
  });
});

// ---- reset-password -----------------------------------------------------

describe("POST /auth/reset-password", () => {
  it("consumes the token, updates the password, revokes all sessions", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      emailVerified: true,
      password: "old password",
      pepper: PEPPER,
    });
    // Pre-existing live session that should be killed by the reset.
    const signIn = await supertest(h.app)
      .post("/auth/sign-in")
      .send({ email: "alice@example.com", password: "old password" });
    expect(signIn.status).toBe(200);
    expect(h.repo.__sessions()).toHaveLength(1);

    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    const token = extractEmailToken(h.emails[0]!.text);

    const res = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "brand new long password" });
    expect(res.status).toBe(200);

    expect(h.repo.__sessions().every((s) => s.revokedAt !== null)).toBe(true);

    // Old password no longer works.
    const oldFail = await supertest(h.app)
      .post("/auth/sign-in")
      .send({ email: "alice@example.com", password: "old password" });
    expect(oldFail.status).toBe(401);

    // New one does.
    const newOk = await supertest(h.app)
      .post("/auth/sign-in")
      .send({ email: "alice@example.com", password: "brand new long password" });
    expect(newOk.status).toBe(200);

    expect(h.audit.actions).toContain("auth.password_reset_completed");
  });

  it("rejects a too-short new password (400, token NOT consumed)", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "old password",
      pepper: PEPPER,
    });
    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    const token = extractEmailToken(h.emails[0]!.text);

    const res = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "short" });
    expect(res.status).toBe(400);

    // Token still usable on next try.
    const goodAttempt = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "brand new long password" });
    expect(goodAttempt.status).toBe(200);
  });

  it("410s when the token has already been used", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "old password",
      pepper: PEPPER,
    });
    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    const token = extractEmailToken(h.emails[0]!.text);

    await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "first new password" });
    const second = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "second new password" });
    expect(second.status).toBe(410);
  });

  it("rejects when the token's purpose is wrong (e.g. signup token in reset endpoint)", async () => {
    const h = buildHarness();
    await supertest(h.app).post("/auth/sign-up").send({
      email: "newbie@example.com",
      password: "correct horse battery staple",
    });
    const signUpToken = extractEmailToken(h.emails[0]!.text);

    const res = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token: signUpToken, password: "different new password" });
    // Repo still consumes the token (single-use). The endpoint
    // refuses to act because the purpose doesn't match — the
    // user keeps the same status and no credential change.
    expect(res.status).toBe(410);
  });
});

// ---- change-password ----------------------------------------------------

describe("POST /auth/change-password", () => {
  async function signInAs(h: Harness, email: string, password: string) {
    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .send({ email, password });
    expect(res.status).toBe(200);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
    const csrf = getCookieValue(cookies, CSRF_COOKIE)!;
    return { cookieHeader, csrf };
  }

  it("requires a session", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .post("/auth/change-password")
      .set("Cookie", `${CSRF_COOKIE}=abc`)
      .set(CSRF_HEADER, "abc")
      .send({ currentPassword: "old", newPassword: "the new one is long" });
    expect(res.status).toBe(401);
  });

  it("rejects without CSRF even when a session is present", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
      pepper: PEPPER,
    });
    const { cookieHeader } = await signInAs(
      h,
      "alice@example.com",
      "current password",
    );

    const res = await supertest(h.app)
      .post("/auth/change-password")
      .set("Cookie", cookieHeader)
      .send({
        currentPassword: "current password",
        newPassword: "next long password",
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_failed");
  });

  it("rejects on wrong current password", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
      pepper: PEPPER,
    });
    const { cookieHeader, csrf } = await signInAs(
      h,
      "alice@example.com",
      "current password",
    );

    const res = await supertest(h.app)
      .post("/auth/change-password")
      .set("Cookie", cookieHeader)
      .set(CSRF_HEADER, csrf)
      .send({
        currentPassword: "WRONG",
        newPassword: "next long password",
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect(h.audit.actions).toContain("auth.password_change_failed");
  });

  it("succeeds and revokes other sessions but keeps the current one", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
      pepper: PEPPER,
    });
    // Two parallel sessions: A and B.
    const a = await signInAs(h, "alice@example.com", "current password");
    await signInAs(h, "alice@example.com", "current password");
    expect(h.repo.__sessions().filter((s) => s.revokedAt === null)).toHaveLength(2);

    const res = await supertest(h.app)
      .post("/auth/change-password")
      .set("Cookie", a.cookieHeader)
      .set(CSRF_HEADER, a.csrf)
      .send({
        currentPassword: "current password",
        newPassword: "next long password",
      });
    expect(res.status).toBe(200);

    const live = h.repo.__sessions().filter((s) => s.revokedAt === null);
    expect(live).toHaveLength(1);
    // The kept session is the one the change request itself used.
    const me = await supertest(h.app)
      .get("/auth/me")
      .set("Cookie", a.cookieHeader);
    expect(me.status).toBe(200);

    // New password works for fresh sign-ins.
    const fresh = await supertest(h.app)
      .post("/auth/sign-in")
      .send({ email: "alice@example.com", password: "next long password" });
    expect(fresh.status).toBe(200);

    expect(h.audit.actions).toContain("auth.password_changed");
  });

  it("400s on a too-short new password", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
      pepper: PEPPER,
    });
    const { cookieHeader, csrf } = await signInAs(
      h,
      "alice@example.com",
      "current password",
    );

    const res = await supertest(h.app)
      .post("/auth/change-password")
      .set("Cookie", cookieHeader)
      .set(CSRF_HEADER, csrf)
      .send({ currentPassword: "current password", newPassword: "short" });
    expect(res.status).toBe(400);
  });
});

describe("password policy", () => {
  it("Stage 2b: SESSION_COOKIE export remains stable", () => {
    expect(SESSION_COOKIE).toBe("pf_session");
  });
});
