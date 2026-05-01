// Shared types + dependency injection shape for the /auth/* handlers.

import type { AuthEnv } from "../env";
import type { AuthRepository, AuthUser } from "../repository";
import type { RateLimitConfig } from "../rate-limit";

/**
 * Pluggable audit-log sink. The resupply-api wires this to
 * `@workspace/resupply-audit`'s `logAudit`. Tests pass a
 * recording stub. Errors are intentionally swallowed by the
 * handler — the user-visible auth path must not fail because
 * an audit row didn't write.
 */
export type AuditWriter = (event: {
  action: string;
  adminEmail?: string | null;
  adminUserId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}) => Promise<void> | void;

/**
 * Pluggable email sender. Resupply-api wires this to
 * `@workspace/resupply-email`'s SendGrid client; tests pass a
 * recording stub. Returning a Promise lets the handler `await`
 * delivery — but the handler treats failures as "logged and
 * swallowed" so a bouncing SendGrid doesn't take down the
 * password reset endpoint.
 */
export type EmailSender = (input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<void> | void;

/**
 * Bundle of dependencies the handlers need. Constructed once at
 * mount time and threaded through every route. Keeps the
 * dependency graph explicit — no module-level singletons.
 */
export interface AuthDeps {
  env: AuthEnv;
  repo: AuthRepository;
  audit: AuditWriter;
  /**
   * Send transactional auth emails (verification, password reset).
   * Required when sign-up / forgot-password handlers are mounted —
   * but supplying a no-op is valid (the handler still issues the
   * token and writes the audit row; the email just goes nowhere).
   */
  email: EmailSender;
  /**
   * Public URL the SPA serves at — used to build the verification
   * + password-reset links emailed to users. No trailing slash.
   * Example: `https://shop.pennpaps.com`.
   */
  publicBaseUrl: string;
  /** Optional override; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override the rate-limit config (tests). Defaults to library defaults. */
  rateLimit?: RateLimitConfig;
  /**
   * Whether the response should set Secure cookies. Pass
   * `process.env.NODE_ENV === "production"` from the caller.
   */
  secureCookies: boolean;
  /** Hashing parameters. Tests pass weaker params; prod uses defaults. */
  passwordHashParams?: {
    memoryCost?: number;
    timeCost?: number;
    parallelism?: number;
  };
  /**
   * Whether public sign-up is allowed. Set true on the customer-
   * facing API (cpap-fitter shop), false on the staff dashboard
   * (resupply-dashboard) — staff are invited, never self-sign-up.
   * When false, POST /auth/sign-up is not mounted at all.
   */
  allowSignUp?: boolean;
  /**
   * Default role assigned to a self-signed-up account. Defaults
   * to "customer". Staff invites set the role explicitly via the
   * (out-of-scope-for-this-PR) team-management endpoint.
   */
  signUpRole?: "customer";
}

/** Locals attached by `requireSession` for downstream handlers. */
export interface AuthRequestLocals {
  user: AuthUser;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      authSessionId?: string;
    }
  }
}
