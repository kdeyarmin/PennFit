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

interface Harness {
  app: Express;
  repo: ReturnType<typeof makeMemoryRepo>;
  audit: AuditWriter & { actions: string[] };
  emails: Array<{ to: string; subject: string; html: string; text: string }>;
}

function buildHarness(
  overrides: Partial<AuthDeps> = {},
  routerOverrides: { uiPathPrefix?: string } = {},
): Harness {
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
  app.use(
    "/auth",
    makeAuthRouter(deps, {
      productName: "TestProduct",
      uiPathPrefix: routerOverrides.uiPathPrefix,
    }),
  );
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

/** Seed a pre-login pf_csrf cookie via GET /auth/csrf. Returns the value. */
async function seedCsrf(app: Express): Promise<string> {
  const r = await supertest(app).get("/auth/csrf");
  const val = getCookieValue(r.headers["set-cookie"], CSRF_COOKIE);
  if (!val) throw new Error("GET /auth/csrf did not set a csrf cookie");
  return val;
}

// ---- sign-up ------------------------------------------------------------

describe("POST /auth/sign-up", () => {
  it("creates an invited user, sends a verification email, returns 200", async () => {
    const h = buildHarness();
    const csrf = await seedCsrf(h.app);
    const res = await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "newbie@example.com",
        password: "correct horse battery staple",
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const created = h.repo
      .__users()
      .find((u) => u.emailLower === "newbie@example.com");
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
    const csrf = await seedCsrf(h.app);
    const res = await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
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
    });

    const csrf = await seedCsrf(h.app);
    const res = await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "existing@example.com",
        password: "another correct horse battery staple",
      });
    expect(res.status).toBe(200);
    expect(h.emails).toHaveLength(0);
    expect(h.audit.actions).toContain("auth.sign_up_existing");
  });

  it("re-attaches an unverified existing account (updates password + re-issues token)", async () => {
    const h = buildHarness();
    const csrf1 = await seedCsrf(h.app);
    await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf1}`)
      .set(CSRF_HEADER, csrf1)
      .send({
        email: "newbie@example.com",
        password: "first attempt password",
      });
    expect(h.repo.__emailTokens()).toHaveLength(1);

    const csrf2 = await seedCsrf(h.app);
    const res = await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf2}`)
      .set(CSRF_HEADER, csrf2)
      .send({
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
    const csrf = await seedCsrf(h.app);
    await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
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
    const csrf = await seedCsrf(h.app);
    await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
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

  it("emits an admin-prefixed reset link when uiPathPrefix=/admin", async () => {
    const h = buildHarness({}, { uiPathPrefix: "/admin" });
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "current password",
    });
    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.html).toContain(
      "https://example.test/admin/reset-password?token=",
    );
    expect(h.emails[0]!.html).not.toMatch(
      /https:\/\/example\.test\/reset-password\?/u,
    );
  });

  it("emits an unprefixed reset link by default (storefront mount)", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_bob",
      emailLower: "bob@example.com",
      password: "current password",
    });
    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "bob@example.com" });
    expect(h.emails[0]!.html).toContain(
      "https://example.test/reset-password?token=",
    );
    expect(h.emails[0]!.html).not.toContain("/admin/reset-password");
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
    });
    // Pre-existing live session that should be killed by the reset.
    const signinCsrf = await seedCsrf(h.app);
    const signIn = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${signinCsrf}`)
      .set(CSRF_HEADER, signinCsrf)
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
    const csrf1 = await seedCsrf(h.app);
    const oldFail = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf1}`)
      .set(CSRF_HEADER, csrf1)
      .send({ email: "alice@example.com", password: "old password" });
    expect(oldFail.status).toBe(401);

    // New one does.
    const csrf2 = await seedCsrf(h.app);
    const newOk = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf2}`)
      .set(CSRF_HEADER, csrf2)
      .send({
        email: "alice@example.com",
        password: "brand new long password",
      });
    expect(newOk.status).toBe(200);

    expect(h.audit.actions).toContain("auth.password_reset_completed");
  });

  // Regression for the bug task-68 closes: an operator typed the
  // user's invite password via team-invite (must_change=true,
  // set_by_admin_at=now), the user reset it from a different
  // device via /auth/reset-password, then signed in DAYS later.
  // If reset-password forgets to clear set_by_admin_at, the
  // sign-in invite-expired gate fires at the 7-day mark and the
  // user is locked out of an account they just successfully reset.
  // The wider guard is the writeUserChosenPassword helper — this
  // test pins the behaviour end-to-end so a future regression in
  // any caller (reset-password, change-password, sign-up, the
  // recovery CLI) is caught.
  it("clears the admin-set timestamp so a reset password keeps working past the invite TTL", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      emailVerified: true,
      password: "operator-typed initial",
    });
    // Simulate the team-invite "Set their password for them"
    // path: mark the credential as operator-typed 9 days ago,
    // BEFORE the user resets it. The reset must wipe both
    // mustChange and set_by_admin_at.
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000);
    const seeded = (await h.repo.findCredentialByUserId("u_alice"))!;
    h.repo.__putCredential({
      ...seeded,
      mustChange: true,
      setByAdminAt: nineDaysAgo,
    });

    // User clicks "forgot password" from a different device and
    // resets to a fresh password they typed themselves.
    await supertest(h.app)
      .post("/auth/forgot-password")
      .send({ email: "alice@example.com" });
    const token = extractEmailToken(h.emails[0]!.text);
    const reset = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token, password: "brand new user-chosen password" });
    expect(reset.status).toBe(200);

    // Post-reset the credential row must NOT look operator-typed
    // anymore — otherwise the invite-expired gate still fires.
    const post = (await h.repo.findCredentialByUserId("u_alice"))!;
    expect(post.setByAdminAt).toBeNull();
    expect(post.mustChange).toBe(false);

    // 10 days later (well past ADMIN_PASSWORD_TTL_MS=7 days)
    // the user signs in — must succeed, not be expired.
    const csrf = await seedCsrf(h.app);
    const signIn = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "brand new user-chosen password",
      });
    expect(signIn.status).toBe(200);
    expect(getCookieValue(signIn.headers["set-cookie"], SESSION_COOKIE))
      .toBeTruthy();
  });

  it("rejects a too-short new password (400, token NOT consumed)", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      password: "old password",
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
    const csrf = await seedCsrf(h.app);
    await supertest(h.app)
      .post("/auth/sign-up")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
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

  it("returns 429 once the per-IP rate limit threshold is hit", async () => {
    const h = buildHarness();
    // Cap is 10 per 15 minutes, keyed by the per-endpoint IP sentinel.
    // Drive the bucket up to the cap with cheap no-op calls (each
    // records a failure attempt regardless of whether the body parses)
    // and assert the next request is rejected with 429 + Retry-After.
    // Avoids hard-coding the test environment's req.ip value.
    for (let i = 0; i < 10; i++) {
      // 410 (invalid token) for the first 10; rate-limit check passes,
      // then the handler records the attempt and rejects the token.
      await supertest(h.app)
        .post("/auth/reset-password")
        .send({ token: "fake-token", password: "brand new long password" });
    }

    const res = await supertest(h.app)
      .post("/auth/reset-password")
      .send({ token: "fake-token", password: "brand new long password" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

// ---- change-password ----------------------------------------------------

describe("POST /auth/change-password", () => {
  async function signInAs(h: Harness, email: string, password: string) {
    const seed = await seedCsrf(h.app);
    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${seed}`)
      .set(CSRF_HEADER, seed)
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
    });
    // Two parallel sessions: A and B.
    const a = await signInAs(h, "alice@example.com", "current password");
    await signInAs(h, "alice@example.com", "current password");
    expect(
      h.repo.__sessions().filter((s) => s.revokedAt === null),
    ).toHaveLength(2);

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
    const csrf3 = await seedCsrf(h.app);
    const fresh = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf3}`)
      .set(CSRF_HEADER, csrf3)
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

describe("rate-limit counter records on every early-return branch", () => {
  // Regression coverage for the per-IP rate-limit bypass: every reset /
  // verify / forgot request — including malformed input that exits early
  // before the token is consumed — must increment the per-endpoint
  // IP-sentinel counter so an attacker can't avoid the cap by spamming
  // unparseable payloads.

  describe("POST /auth/reset-password", () => {
    it("records IP-sentinel failure on Zod-parse rejection", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__reset:");
      const res = await supertest(h.app)
        .post("/auth/reset-password")
        .send({ token: "" }); // empty string → fails z.string().min(1)
      expect(res.status).toBe(400);
      expect(h.repo.__failuresStartingWith("__reset:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on password-policy rejection", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__reset:");
      // Use a well-formed token so the password-policy rejection is the
      // branch under test (not the hashToken-null branch).
      const res = await supertest(h.app)
        .post("/auth/reset-password")
        .send({ token: "A".repeat(43), password: "short" });
      expect(res.status).toBe(400);
      expect(h.repo.__failuresStartingWith("__reset:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on hashToken null (invalid token bytes)", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__reset:");
      // hashToken returns null for tokens that fail base64url decode.
      // A control character is guaranteed to be invalid base64url.
      const res = await supertest(h.app)
        .post("/auth/reset-password")
        .send({ token: "not*valid*base64!", password: "brand new long password" });
      expect(res.status).toBe(410);
      expect(h.repo.__failuresStartingWith("__reset:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on invalid/expired token", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__reset:");
      // Well-formed (43-char base64url) but unknown token: hashToken
      // succeeds, then consumeEmailToken returns null.
      const res = await supertest(h.app)
        .post("/auth/reset-password")
        .send({
          token: "A".repeat(43),
          password: "brand new long password",
        });
      expect(res.status).toBe(410);
      expect(h.repo.__failuresStartingWith("__reset:")).toBe(before + 1);
    });
  });

  describe("POST /auth/verify-email", () => {
    it("records IP-sentinel failure on Zod-parse rejection", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__verify:");
      const res = await supertest(h.app)
        .post("/auth/verify-email")
        .send({ token: "" });
      expect(res.status).toBe(400);
      expect(h.repo.__failuresStartingWith("__verify:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on hashToken null (invalid token bytes)", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__verify:");
      const res = await supertest(h.app)
        .post("/auth/verify-email")
        .send({ token: "not*valid*base64!" });
      expect(res.status).toBe(410);
      expect(h.repo.__failuresStartingWith("__verify:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on invalid/expired token", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__verify:");
      // Well-formed (43-char base64url) but unknown token: hashToken
      // succeeds, then consumeEmailToken returns null.
      const res = await supertest(h.app)
        .post("/auth/verify-email")
        .send({ token: "A".repeat(43) });
      expect(res.status).toBe(410);
      expect(h.repo.__failuresStartingWith("__verify:")).toBe(before + 1);
    });
  });

  describe("POST /auth/forgot-password", () => {
    it("records IP-sentinel failure on Zod-parse rejection", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__forgot:");
      // Missing email field → Zod parse fails. Endpoint still returns 200
      // (non-enumeration) but the counter must tick.
      const res = await supertest(h.app)
        .post("/auth/forgot-password")
        .send({});
      expect(res.status).toBe(200);
      expect(h.repo.__failuresStartingWith("__forgot:")).toBe(before + 1);
    });

    it("records IP-sentinel failure on email-normalize rejection", async () => {
      const h = buildHarness();
      const before = h.repo.__failuresStartingWith("__forgot:");
      const res = await supertest(h.app)
        .post("/auth/forgot-password")
        .send({ email: "not-a-valid-email" });
      expect(res.status).toBe(200);
      expect(h.repo.__failuresStartingWith("__forgot:")).toBe(before + 1);
    });
  });
});

describe("password policy", () => {
  it("Stage 2b: SESSION_COOKIE export remains stable", () => {
    expect(SESSION_COOKIE).toBe("pf_session");
  });
});
