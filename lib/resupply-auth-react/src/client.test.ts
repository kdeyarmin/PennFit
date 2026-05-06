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
});
