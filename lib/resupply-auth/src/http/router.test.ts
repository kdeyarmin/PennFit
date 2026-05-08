// Handler-level integration tests for the /auth/* router.
//
// We mount makeAuthRouter on a bare express app + the in-memory
// repo from ../test-helpers and drive it through supertest. No
// Postgres; no real argon2 production parameters (tests use
// FAST_PARAMS via seedUserWithPassword).

import express, { type Express } from "express";
import supertest from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../cookies";
import { readAuthEnv } from "../env";
import { DEFAULT_RATE_LIMIT } from "../rate-limit";
import { makeMemoryRepo, seedUserWithPassword } from "../test-helpers";

import { makeAuthRouter } from "./index";
import type { AuditWriter, AuthDeps } from "./types";

interface Harness {
  app: Express;
  repo: ReturnType<typeof makeMemoryRepo>;
  audit: AuditWriter & {
    events: Array<{ action: string; metadata?: Record<string, unknown> }>;
  };
  emails: Array<{ to: string; subject: string; html: string; text: string }>;
}

function buildHarness(overrides: Partial<AuthDeps> = {}): Harness {
  const repo = makeMemoryRepo();
  const auditEvents: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
  const audit: AuditWriter & { events: typeof auditEvents } = Object.assign(
    (event: { action: string }) => {
      auditEvents.push(event);
    },
    { events: auditEvents },
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
  app.use("/auth", makeAuthRouter(deps, { productName: "TestProduct" }));
  return { app, repo, audit, emails };
}

/** Pull the value of a Set-Cookie header by cookie name. */
function getCookieValue(
  setCookie: string | string[] | undefined,
  name: string,
): string | null {
  if (!setCookie) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
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

describe("GET /auth/csrf", () => {
  it("issues a pf_csrf cookie when none is present", async () => {
    const h = buildHarness();
    const res = await supertest(h.app).get("/auth/csrf");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(getCookieValue(res.headers["set-cookie"], CSRF_COOKIE)).toBeTruthy();
  });

  it("does not overwrite an existing pf_csrf cookie", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .get("/auth/csrf")
      .set("Cookie", `${CSRF_COOKIE}=existing-value`);
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

describe("POST /auth/sign-in", () => {
  let h: Harness;

  beforeEach(() => {
    h = buildHarness();
  });

  async function seedAlice(
    opts: { verified?: boolean; status?: "active" | "locked" | "revoked" } = {},
  ) {
    return seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      role: "agent",
      status: opts.status ?? "active",
      emailVerified: opts.verified ?? true,
      password: "correct horse battery staple",
    });
  }

  it("returns 403 csrf_failed when CSRF header is missing", async () => {
    await seedAlice();
    const res = await supertest(h.app).post("/auth/sign-in").send({
      email: "alice@example.com",
      password: "correct horse battery staple",
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_failed");
  });

  it("returns 200 + sets session + csrf cookies on valid creds", async () => {
    await seedAlice();
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const setCookie = res.headers["set-cookie"] as unknown as
      | string[]
      | undefined;
    expect(getCookieValue(setCookie, SESSION_COOKIE)).toBeTruthy();
    expect(getCookieValue(setCookie, CSRF_COOKIE)).toBeTruthy();

    expect(h.repo.__sessions()).toHaveLength(1);
    expect(h.repo.__successes("alice@example.com")).toBe(1);
    expect(h.audit.events.map((e) => e.action)).toContain("auth.sign_in");
  });

  it("issues pf_session with HttpOnly + SameSite=Lax + Path=/ + Max-Age, and pf_csrf with the same flags MINUS HttpOnly (P1.5)", async () => {
    await seedAlice();
    const csrf = await seedCsrf(h.app);

    // Harness sets secureCookies: false (development), so Secure must
    // NOT appear. The production path is covered by the unit-level
    // tests in cookies.test.ts; this case pins the env-aware wiring
    // through the live sign-in handler so a regression in the cookie
    // helper or its caller fails CI.
    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });
    expect(res.status).toBe(200);

    const setCookie = res.headers["set-cookie"] as unknown as
      | string[]
      | undefined;
    expect(setCookie).toBeDefined();
    const sessionLine = setCookie!.find((c) =>
      c.startsWith(`${SESSION_COOKIE}=`),
    );
    const csrfLine = setCookie!.find((c) => c.startsWith(`${CSRF_COOKIE}=`));
    expect(sessionLine).toBeDefined();
    expect(csrfLine).toBeDefined();

    // pf_session: HttpOnly is non-negotiable (XSS defense); SameSite=Lax
    // + Path=/ + Max-Age round out the policy.
    expect(sessionLine).toContain("HttpOnly");
    expect(sessionLine).toContain("SameSite=Lax");
    expect(sessionLine).toContain("Path=/");
    expect(sessionLine).toMatch(/Max-Age=\d+/u);
    // Harness is dev (secureCookies:false), so Secure must NOT be set.
    expect(sessionLine).not.toContain("Secure");

    // pf_csrf: deliberately readable from JS so the SPA can echo it as
    // X-PF-CSRF. Everything else mirrors the session cookie.
    expect(csrfLine).not.toContain("HttpOnly");
    expect(csrfLine).toContain("SameSite=Lax");
    expect(csrfLine).toContain("Path=/");
    expect(csrfLine).toMatch(/Max-Age=\d+/u);
    expect(csrfLine).not.toContain("Secure");
  });

  it("returns 401 + records failure on wrong password", async () => {
    await seedAlice();
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ email: "alice@example.com", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect(res.body.message).toBe("Invalid email or password.");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(h.repo.__failures("alice@example.com")).toBe(1);
    const failedEvent = h.audit.events.find(
      (e) => e.action === "auth.sign_in_failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.metadata?.reason).toBe("wrong_password");
  });

  it("returns the same generic message when the user does not exist", async () => {
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ email: "ghost@example.com", password: "anything" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    expect(res.body.message).toBe("Invalid email or password.");
  });

  it("returns 403 email_unverified when account exists but email not verified", async () => {
    await seedAlice({ verified: false });
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("email_unverified");
    const failedEvent = h.audit.events.find(
      (e) => e.action === "auth.sign_in_failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.metadata?.reason).toBe("email_unverified");
  });

  it("returns the generic message when account is locked", async () => {
    await seedAlice({ status: "locked" });
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
    const failedEvent = h.audit.events.find(
      (e) => e.action === "auth.sign_in_failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.metadata?.reason).toBe("locked");
  });

  it("records reason:revoked when account is revoked", async () => {
    await seedAlice({ status: "revoked" });
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });

    expect(res.status).toBe(401);
    const failedEvent = h.audit.events.find(
      (e) => e.action === "auth.sign_in_failed",
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.metadata?.reason).toBe("revoked");
  });

  it("returns 400 on missing fields", async () => {
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({ email: "alice@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });

  it("returns 429 once the per-email rate limit threshold is hit", async () => {
    await seedAlice();
    h.repo.__forceFailures("alice@example.com", DEFAULT_RATE_LIMIT.maxPerEmail);
    const csrf = await seedCsrf(h.app);

    const res = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${csrf}`)
      .set(CSRF_HEADER, csrf)
      .send({
        email: "alice@example.com",
        password: "correct horse battery staple",
      });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /auth/sign-out", () => {
  it("requires CSRF and returns 200 even without a session", async () => {
    const h = buildHarness();
    const res = await supertest(h.app)
      .post("/auth/sign-out")
      .set("Cookie", `${CSRF_COOKIE}=abc`)
      .set(CSRF_HEADER, "abc");
    expect(res.status).toBe(200);
  });

  it("rejects with 403 when CSRF token missing", async () => {
    const h = buildHarness();
    const res = await supertest(h.app).post("/auth/sign-out");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("csrf_failed");
  });

  it("revokes the active session when one exists", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_bob",
      emailLower: "bob@example.com",
      role: "admin",
      emailVerified: true,
      password: "p4ssword!",
    });
    const seed = await seedCsrf(h.app);
    const signIn = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${seed}`)
      .set(CSRF_HEADER, seed)
      .send({ email: "bob@example.com", password: "p4ssword!" });
    expect(signIn.status).toBe(200);
    const cookies = signIn.headers["set-cookie"] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE)!;

    const out = await supertest(h.app)
      .post("/auth/sign-out")
      .set("Cookie", cookies.map((c) => c.split(";")[0]).join("; "))
      .set(CSRF_HEADER, csrf);
    expect(out.status).toBe(200);
    expect(h.repo.__sessions()[0]?.revokedAt).not.toBeNull();
  });
});

describe("GET /auth/me", () => {
  it("returns 401 when no session cookie is sent", async () => {
    const h = buildHarness();
    const res = await supertest(h.app).get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("session_required");
  });

  it("returns the user payload after sign-in", async () => {
    const h = buildHarness();
    await seedUserWithPassword(h.repo, {
      id: "u_alice",
      emailLower: "alice@example.com",
      role: "admin",
      emailVerified: true,
      password: "p4ssword!",
    });
    const seed = await seedCsrf(h.app);
    const signIn = await supertest(h.app)
      .post("/auth/sign-in")
      .set("Cookie", `${CSRF_COOKIE}=${seed}`)
      .set(CSRF_HEADER, seed)
      .send({ email: "alice@example.com", password: "p4ssword!" });
    const cookies = signIn.headers["set-cookie"] as unknown as string[];

    const me = await supertest(h.app)
      .get("/auth/me")
      .set("Cookie", cookies.map((c) => c.split(";")[0]).join("; "));

    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      id: "u_alice",
      email: "alice@example.com",
      role: "admin",
      displayName: null,
      emailVerified: true,
    });
  });
});
