import { afterEach, describe, expect, it } from "vitest";

import { AuthError, createAuthClient } from "./client";

function setCsrfCookie(value: string): void {
  document.cookie = `pf_csrf=${encodeURIComponent(value)}; path=/`;
}

function clearCookies(): void {
  for (const c of document.cookie.split(";")) {
    const name = c.split("=")[0]?.trim();
    if (name)
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

afterEach(() => {
  clearCookies();
});

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
}

function makeFetch(responses: Array<{ status: number; body?: unknown }>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let idx = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(rawHeaders)) {
      headers[k.toLowerCase()] = rawHeaders[k]!;
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
      credentials: init?.credentials,
    });
    const r = responses[idx++] ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(r.body ?? null), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fakeFetch, calls };
}

describe("createAuthClient", () => {
  it("fetches csrf seed before sign-in, then posts sign-in", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      { status: 200, body: { ok: true } }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signIn({ email: "a@b.co", password: "hunter22" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("/api/auth/csrf");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[1]!.url).toBe("/api/auth/sign-in");
    expect(calls[1]!.method).toBe("POST");
  });

  it("sends sign-in to <base>/sign-in with credentials and JSON body", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      { status: 200, body: { ok: true } }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signIn({ email: "a@b.co", password: "hunter22" });
    const signInCall = calls[1]!;
    expect(signInCall.url).toBe("/api/auth/sign-in");
    expect(signInCall.method).toBe("POST");
    expect(signInCall.credentials).toBe("include");
    expect(signInCall.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(signInCall.body!)).toEqual({
      email: "a@b.co",
      password: "hunter22",
    });
  });

  it("sign-in injects X-PF-CSRF header when cookie is present", async () => {
    setCsrfCookie("test-csrf-value");
    const { fetch, calls } = makeFetch([
      { status: 200 }, // GET /auth/csrf (cookie already present, no-op on server)
      { status: 200 }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signIn({ email: "a@b.co", password: "x" });
    expect(calls[1]!.headers["x-pf-csrf"]).toBe("test-csrf-value");
  });

  it("strips trailing slash from basePath", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200 }, // GET /auth/csrf
      { status: 200 }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth/", fetch });
    await client.signIn({ email: "a@b.co", password: "x" });
    expect(calls[1]!.url).toBe("/api/auth/sign-in");
  });

  it("sign-out injects X-PF-CSRF from the pf_csrf cookie", async () => {
    setCsrfCookie("abc-csrf-token");
    const { fetch, calls } = makeFetch([{ status: 200 }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signOut();
    expect(calls[0]!.headers["x-pf-csrf"]).toBe("abc-csrf-token");
  });

  it("sign-out works without the cookie (server returns CSRF error)", async () => {
    const { fetch, calls } = makeFetch([
      {
        status: 403,
        body: { error: "csrf_failed", message: "Verify the request." },
      },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await expect(client.signOut()).rejects.toBeInstanceOf(AuthError);
    expect(calls[0]!.headers["x-pf-csrf"]).toBeUndefined();
  });

  it("change-password injects CSRF too", async () => {
    setCsrfCookie("c");
    const { fetch, calls } = makeFetch([{ status: 200 }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.changePassword({
      currentPassword: "old",
      newPassword: "new long password",
    });
    expect(calls[0]!.headers["x-pf-csrf"]).toBe("c");
  });

  it("fetchMe returns null on 401", async () => {
    const { fetch } = makeFetch([
      { status: 401, body: { error: "session_required" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    expect(await client.fetchMe()).toBeNull();
  });

  it("fetchMe returns the parsed body on 200", async () => {
    const me = {
      id: "u1",
      email: "x@y.z",
      role: "admin",
      displayName: null,
      emailVerified: true,
    };
    const { fetch } = makeFetch([{ status: 200, body: me }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const result = await client.fetchMe();
    expect(result).toEqual(me);
  });

  it("non-2xx throws AuthError with code, message, status, extra", async () => {
    const { fetch } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      {
        status: 429,
        body: {
          error: "rate_limited",
          message: "Slow down.",
          retryAfterSeconds: 900,
        },
      },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    let caught: unknown;
    try {
      await client.signIn({ email: "x@y.z", password: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthError);
    const e = caught as AuthError;
    expect(e.status).toBe(429);
    expect(e.code).toBe("rate_limited");
    expect(e.userMessage).toBe("Slow down.");
    expect(e.extra).toEqual({ retryAfterSeconds: 900 });
  });

  it("falls back to a default user message when the server omits one", async () => {
    const { fetch } = makeFetch([
      { status: 410, body: { error: "invalid_input" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .verifyEmail({ token: "t" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.status).toBe(410);
    expect(err.userMessage).toBe("This link is no longer valid.");
  });

  it("falls back to 'unknown' code when the response is not JSON", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("not json", { status: 502 });
    const client = createAuthClient({
      basePath: "/api/auth",
      fetch: fakeFetch,
    });
    const err = (await client
      .signIn({ email: "x@y.z", password: "x" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.status).toBe(502);
    expect(err.code).toBe("unknown");
  });

  // ── PR change: mustChangePassword removed from AuthMe ──────────────────
  // The admin SPA previously used mustChangePassword to gate entry to the
  // console, redirecting to /admin/change-password when true. That gate has
  // been removed; AuthMe must not expose the field.

  it("fetchMe returns an AuthMe without mustChangePassword when server omits it", async () => {
    const me = {
      id: "u2",
      email: "admin@example.com",
      role: "admin",
      displayName: "Admin User",
      emailVerified: true,
    };
    const { fetch } = makeFetch([{ status: 200, body: me }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const result = await client.fetchMe();
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("mustChangePassword");
  });

  it("fetchMe parses the full AuthMe shape (id, email, role, displayName, emailVerified) correctly", async () => {
    const me = {
      id: "u3",
      email: "rep@example.com",
      role: "agent",
      displayName: null,
      emailVerified: false,
    };
    const { fetch } = makeFetch([{ status: 200, body: me }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const result = await client.fetchMe();
    expect(result).toEqual(me);
  });

  // ── signIn MFA flow ────────────────────────────────────────────────────────

  it("signIn returns mfaRequired: true with challengeToken when server indicates MFA is needed", async () => {
    const { fetch } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      {
        status: 200,
        body: {
          ok: true,
          mfaRequired: true,
          challengeToken: "challenge-abc-123",
        },
      },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const result = await client.signIn({ email: "a@b.co", password: "pass" });
    expect(result.ok).toBe(true);
    expect(result.mfaRequired).toBe(true);
    if (result.mfaRequired) {
      expect(result.challengeToken).toBe("challenge-abc-123");
    }
  });

  it("signIn returns { ok: true } without mfaRequired when server does not set mfaRequired", async () => {
    const { fetch } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      { status: 200, body: { ok: true } }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const result = await client.signIn({ email: "a@b.co", password: "pass" });
    expect(result.ok).toBe(true);
    expect(result.mfaRequired).toBeFalsy();
  });

  // ── verifySignInMfa ────────────────────────────────────────────────────────

  it("verifySignInMfa seeds CSRF, then posts to /sign-in/verify-mfa with code", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      { status: 200, body: { ok: true } }, // POST /sign-in/verify-mfa
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.verifySignInMfa({
      challengeToken: "tok-1",
      code: "123456",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("/api/auth/csrf");
    expect(calls[1]!.url).toBe("/api/auth/sign-in/verify-mfa");
    expect(calls[1]!.method).toBe("POST");
    const body = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
    expect(body.challengeToken).toBe("tok-1");
    expect(body.code).toBe("123456");
  });

  it("verifySignInMfa accepts recoveryCode instead of code", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: { ok: true } }, // GET /auth/csrf
      { status: 200, body: { ok: true } }, // POST /sign-in/verify-mfa
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.verifySignInMfa({
      challengeToken: "tok-2",
      recoveryCode: "ABCD-EFGH",
    });
    const body = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
    expect(body.recoveryCode).toBe("ABCD-EFGH");
    expect(body).not.toHaveProperty("code");
  });

  it("verifySignInMfa injects X-PF-CSRF header when cookie is present", async () => {
    setCsrfCookie("mfa-csrf");
    const { fetch, calls } = makeFetch([
      { status: 200 }, // GET /auth/csrf
      { status: 200 }, // POST /sign-in/verify-mfa
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.verifySignInMfa({ challengeToken: "t", code: "000000" });
    expect(calls[1]!.headers["x-pf-csrf"]).toBe("mfa-csrf");
  });

  it("verifySignInMfa throws AuthError on mfa_challenge_expired", async () => {
    const { fetch } = makeFetch([
      { status: 200 }, // GET /auth/csrf
      {
        status: 401,
        body: { error: "mfa_challenge_expired", message: "Challenge expired." },
      },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .verifySignInMfa({ challengeToken: "stale", code: "000000" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("mfa_challenge_expired");
  });

  // ── forgotPassword ─────────────────────────────────────────────────────────

  it("forgotPassword sends a POST to /forgot-password with the email", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.forgotPassword({ email: "user@example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/forgot-password");
    expect(calls[0]!.method).toBe("POST");
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.email).toBe("user@example.com");
  });

  it("forgotPassword does NOT seed CSRF (no side-effect fetch)", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.forgotPassword({ email: "user@example.com" });
    // Only one call — no CSRF seed needed for this endpoint
    expect(calls).toHaveLength(1);
  });

  it("forgotPassword throws AuthError on non-2xx", async () => {
    const { fetch } = makeFetch([
      {
        status: 429,
        body: { error: "rate_limited", message: "Too many requests." },
      },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .forgotPassword({ email: "user@example.com" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe("rate_limited");
  });

  // ── resetPassword ──────────────────────────────────────────────────────────

  it("resetPassword sends a POST to /reset-password with token and password", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.resetPassword({
      token: "reset-tok-xyz",
      password: "newSecurePass!",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/auth/reset-password");
    expect(calls[0]!.method).toBe("POST");
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.token).toBe("reset-tok-xyz");
    expect(body.password).toBe("newSecurePass!");
  });

  it("resetPassword does NOT seed CSRF before the call", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: { ok: true } }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.resetPassword({ token: "t", password: "p" });
    expect(calls).toHaveLength(1);
  });

  it("resetPassword throws AuthError with 410 default message for an expired token", async () => {
    const { fetch } = makeFetch([
      { status: 410, body: { error: "invalid_input" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .resetPassword({ token: "expired", password: "any" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err).toBeInstanceOf(AuthError);
    expect(err.status).toBe(410);
    expect(err.userMessage).toBe("This link is no longer valid.");
  });

  // ── defaultMessageForStatus — default message fallbacks ───────────────────

  it("defaultMessageForStatus for 401 falls back to 'Sign-in required.'", async () => {
    const { fetch } = makeFetch([
      { status: 401, body: { error: "session_required" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .forgotPassword({ email: "x@y.z" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.userMessage).toBe("Sign-in required.");
  });

  it("defaultMessageForStatus for 403 falls back to 'Not authorized.'", async () => {
    const { fetch } = makeFetch([
      { status: 403, body: { error: "csrf_failed" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .forgotPassword({ email: "x@y.z" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.userMessage).toBe("Not authorized.");
  });

  it("defaultMessageForStatus for 429 falls back to 'Too many attempts. Please slow down.'", async () => {
    const { fetch } = makeFetch([
      { status: 429, body: { error: "rate_limited" } },
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .forgotPassword({ email: "x@y.z" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.userMessage).toBe("Too many attempts. Please slow down.");
  });

  it("defaultMessageForStatus for 500 falls back to 'Something went wrong on our side.'", async () => {
    const { fetch } = makeFetch([{ status: 500, body: { error: "internal" } }]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    const err = (await client
      .forgotPassword({ email: "x@y.z" })
      .catch((e: unknown) => e)) as AuthError;
    expect(err.userMessage).toBe("Something went wrong on our side.");
  });

  // ── CSRF cookie parsing edge cases ─────────────────────────────────────────

  it("injects CSRF header even when pf_csrf is one of several cookies", async () => {
    // Set multiple cookies; only pf_csrf should be picked up as the CSRF token.
    document.cookie = "other_cookie=should-be-ignored; path=/";
    setCsrfCookie("multi-cookie-csrf");
    const { fetch, calls } = makeFetch([
      { status: 200 }, // GET /auth/csrf
      { status: 200 }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signIn({ email: "a@b.co", password: "x" });
    expect(calls[1]!.headers["x-pf-csrf"]).toBe("multi-cookie-csrf");
  });

  it("CSRF value is URL-decoded before being placed in the header", async () => {
    // setCsrfCookie encodes the value; the client must decode it
    document.cookie = `pf_csrf=${encodeURIComponent("csrf+with=special")}; path=/`;
    const { fetch, calls } = makeFetch([
      { status: 200 }, // GET /auth/csrf
      { status: 200 }, // POST /sign-in
    ]);
    const client = createAuthClient({ basePath: "/api/auth", fetch });
    await client.signIn({ email: "a@b.co", password: "x" });
    expect(calls[1]!.headers["x-pf-csrf"]).toBe("csrf+with=special");
  });
});
