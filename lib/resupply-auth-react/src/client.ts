// Fetch wrapper for the in-house /auth/* HTTP API.
//
// Why this lives separate from the resupply-api-client:
//   * The auth endpoints don't go through the OpenAPI codegen (they
//     issue / consume cookies, not bearer tokens).
//   * They run on different basePaths in different products
//     (`/api/auth/*` on cpap-fitter, `/resupply-api/auth/*` on
//     resupply-dashboard) and the consumer wires the path in once
//     at app startup.
//   * They need same-origin `credentials: "include"` semantics on
//     every request — cookies do the auth.
//
// The CSRF helper reads the `pf_csrf` cookie (server-issued at
// sign-in, NOT HttpOnly so the SPA can read it) and echoes it as
// the `X-PF-CSRF` header on state-changing requests. The server-
// side double-submit check (lib/resupply-auth/src/csrf.ts) compares
// the two values in constant time.

export interface AuthClientConfig {
  /**
   * Mount point of the /auth router on the server. Must match the
   * server's `app.use(...)` path. No trailing slash. Examples:
   * `/api/auth`, `/resupply-api/auth`.
   */
  basePath: string;
  /**
   * Override `fetch`. Defaults to `globalThis.fetch`. Tests pass a
   * recording fake; the SPAs never override.
   */
  fetch?: typeof fetch;
}

export interface AuthMe {
  id: string;
  email: string;
  role: "customer" | "agent" | "admin";
  displayName: string | null;
  emailVerified: boolean;
}

export type AuthErrorCode =
  | "invalid_input"
  | "invalid_credentials"
  | "session_required"
  | "csrf_failed"
  | "rate_limited"
  | "account_locked"
  | "email_unverified"
  | "internal"
  | "unknown";

export class AuthError extends Error {
  readonly status: number;
  readonly code: AuthErrorCode;
  /**
   * Server-supplied user-facing message. Safe to render directly —
   * the server is responsible for not leaking enumeration via this
   * field (see lib/resupply-auth/src/http/responses.ts).
   */
  readonly userMessage: string;
  readonly extra: Record<string, unknown>;
  constructor(
    status: number,
    code: AuthErrorCode,
    userMessage: string,
    extra: Record<string, unknown> = {},
  ) {
    super(userMessage);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    this.userMessage = userMessage;
    this.extra = extra;
  }
}

const CSRF_COOKIE = "pf_csrf";
const CSRF_HEADER = "X-PF-CSRF";

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const cookie = document.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === CSRF_COOKIE) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

export interface AuthClient {
  signIn(input: { email: string; password: string }): Promise<void>;
  signUp(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  forgotPassword(input: { email: string }): Promise<void>;
  resetPassword(input: { token: string; password: string }): Promise<void>;
  verifyEmail(input: { token: string }): Promise<void>;
  changePassword(input: {
    currentPassword: string;
    newPassword: string;
  }): Promise<void>;
  /** Returns the current user, or null when no session is present. */
  fetchMe(): Promise<AuthMe | null>;
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const base = config.basePath.replace(/\/$/, "");

  async function call(
    path: string,
    init: {
      method: "GET" | "POST";
      body?: unknown;
      requireCsrf?: boolean;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (init.requireCsrf) {
      const csrf = readCsrfCookie();
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    return fetchImpl(`${base}${path}`, {
      method: init.method,
      credentials: "include",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  /** Throw an AuthError on non-2xx; otherwise return the parsed body. */
  async function expectOk(res: Response): Promise<unknown> {
    if (res.status >= 200 && res.status < 300) {
      // Sign-in / sign-out / etc. return `{ ok: true }`. We don't
      // need the body for the void-returning mutations; just consume
      // it to free the network connection.
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    let body: { error?: string; message?: string } & Record<string, unknown> =
      {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // server returned non-JSON — that's an internal error
    }
    const code = (
      typeof body.error === "string" ? body.error : "unknown"
    ) as AuthErrorCode;
    const message =
      (typeof body.message === "string" && body.message) ||
      defaultMessageForStatus(res.status);
    const { error: _e, message: _m, ...extra } = body;
    void _e;
    void _m;
    throw new AuthError(res.status, code, message, extra);
  }

  function defaultMessageForStatus(status: number): string {
    if (status === 401) return "Sign-in required.";
    if (status === 403) return "Not authorized.";
    if (status === 404) return "Not found.";
    if (status === 410) return "This link is no longer valid.";
    if (status === 429) return "Too many attempts. Please slow down.";
    if (status >= 500) return "Something went wrong on our side.";
    return "Request failed.";
  }

  return {
    async signIn(input) {
      const res = await call("/sign-in", { method: "POST", body: input });
      await expectOk(res);
    },
    async signUp(input) {
      const res = await call("/sign-up", { method: "POST", body: input });
      await expectOk(res);
    },
    async signOut() {
      const res = await call("/sign-out", {
        method: "POST",
        requireCsrf: true,
      });
      await expectOk(res);
    },
    async forgotPassword(input) {
      const res = await call("/forgot-password", {
        method: "POST",
        body: input,
      });
      await expectOk(res);
    },
    async resetPassword(input) {
      const res = await call("/reset-password", {
        method: "POST",
        body: input,
      });
      await expectOk(res);
    },
    async verifyEmail(input) {
      const res = await call("/verify-email", {
        method: "POST",
        body: input,
      });
      await expectOk(res);
    },
    async changePassword(input) {
      const res = await call("/change-password", {
        method: "POST",
        body: input,
        requireCsrf: true,
      });
      await expectOk(res);
    },
    async fetchMe() {
      const res = await call("/me", { method: "GET" });
      if (res.status === 401) return null;
      const body = (await expectOk(res)) as AuthMe;
      return body;
    },
  };
}
