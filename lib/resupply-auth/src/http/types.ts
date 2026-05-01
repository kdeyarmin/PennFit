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
 * Stage 4c — opaque customer-id remapping for the in-house
 * sign-in path.
 *
 * Some products carry a separate customer table whose primary key
 * was historically a Clerk user id (e.g. `shop_customers.clerk_user_id`).
 * After cutover, an in-house auth user's id is a UUID, and every
 * downstream FK that keys off "the customer's clerk_user_id"
 * would mismatch.
 *
 * The resolver bridges that. Given an authenticated `auth.users`
 * row, it returns the string the rest of the API should treat
 * as the customer key — typically:
 *
 *   * For an existing customer the Stage 4c backfill linked, the
 *     legacy `shop_customers.clerk_user_id` value.
 *   * For a brand-new in-house sign-up, a freshly minted
 *     customer-table row keyed by `auth.users.id` (the resolver
 *     does the upsert).
 *
 * Default behaviour (no resolver supplied): `auth.users.id` is
 * passed through unchanged. resupply-dashboard uses this default;
 * api-server installs a real resolver that does the
 * shop_customers lookup.
 */
export type CustomerIdResolver = (input: {
  authUserId: string;
  emailLower: string;
  displayName: string | null;
}) => Promise<{
  /** Value to put in `req.userClerkId` after resolution. */
  customerKey: string;
  /** Email surfaced to enrichment-aware shop endpoints. */
  email: string | null;
  /** Display name surfaced to enrichment-aware shop endpoints. */
  displayName: string | null;
}>;

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
  /**
   * Optional. When supplied, the customer-auth middleware
   * (`requireSignedIn` / `attachSignedIn`) calls this AFTER an
   * in-house cookie has been resolved to an `auth.users` row.
   * The resolved `customerKey` lands in `req.userClerkId` instead
   * of the raw `auth.users.id`. Default: pass-through.
   *
   * Wired on api-server only; resupply-dashboard has no shop
   * customer table.
   */
  customerIdResolver?: CustomerIdResolver;
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
