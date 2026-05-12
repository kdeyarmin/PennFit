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
 * Opaque customer-id remapping for the in-house sign-in path.
 *
 * Some products carry a separate customer table whose primary
 * key (`shop_customers.customer_id`) is preserved independently
 * of the auth user id so downstream joins stay stable. An
 * in-house auth user's id is a UUID, and that stable customer key
 * may differ from `auth.users.id` for historical rows that were
 * linked before the customer column was renamed.
 *
 * The resolver bridges that. Given an authenticated `auth.users`
 * row, it returns the string the rest of the API should treat
 * as the customer key — typically:
 *
 *   * For an existing customer linked via `shop_customers.auth_user_id`,
 *     the `shop_customers.customer_id` value.
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
  /** Value to put in `req.userCustomerId` after resolution. */
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
   * The resolved `customerKey` lands in `req.userCustomerId` instead
   * of the raw `auth.users.id`. Default: pass-through.
   *
   * Wired on api-server only; resupply-dashboard has no shop
   * customer table.
   */
  customerIdResolver?: CustomerIdResolver;
  /**
   * Optional MFA probe. When supplied, the sign-in handler calls
   * `findActiveSecret(user.id)` AFTER the password verifies; if the
   * user has an active TOTP enrollment, sign-in returns
   * `{ ok: true, mfaRequired: true, challengeToken }` INSTEAD of
   * issuing the session cookie, and the SPA must call
   * `POST /sign-in/verify-mfa` to exchange the challenge + code for
   * the session.
   *
   * The probe is OPTIONAL so the customer-facing storefront (which
   * has no MFA surface in this phase) wires `undefined` and gets
   * the legacy single-step flow. The dashboard wires a real
   * implementation against `admin_mfa_secrets`.
   *
   * Both methods MUST fail closed: a thrown error from
   * `findActiveSecret` short-circuits sign-in with a generic 500,
   * preventing the password-only fallback. `recordVerify` is called
   * AFTER a successful TOTP verify to bump last_used_counter +
   * last_used_at.
   */
  mfa?: MfaProbe;
  /**
   * HMAC key used to sign the MFA challenge token (the bridge
   * between password-verify and TOTP-verify). Bytes, not a string.
   * Required when `mfa` is supplied; ignored otherwise.
   */
  mfaChallengeHmacKey?: Buffer | Uint8Array;
}

/**
 * MFA probe contract — the auth lib stays DB-agnostic; the host
 * artifact wires a real implementation against its DB.
 */
export interface MfaProbe {
  /**
   * Return an active TOTP secret for the user, or null when the
   * user has NO MFA enrolled. "Active" means
   * admin_mfa_secrets.verified_at IS NOT NULL.
   *
   * For multi-device support, this returns ANY active secret —
   * the caller uses it to detect "does the user have MFA at all?"
   * The verify path uses `findAllActiveSecrets` instead to try
   * each enrolled device.
   */
  findActiveSecret(userId: string): Promise<MfaProbeSecret | null>;
  /**
   * Return every active TOTP secret for the user, ordered by
   * created_at ascending (oldest first). Used by the sign-in
   * verify-mfa path to try each enrolled device.
   *
   * Optional for backwards-compat: artifacts that haven't
   * shipped multi-device yet can leave this unimplemented, and
   * the verify path falls back to the single-secret findActiveSecret.
   */
  findAllActiveSecrets?(
    userId: string,
  ): Promise<Array<MfaProbeSecret & { id: string }>>;
  /**
   * Bump last_used_counter + last_used_at after a successful
   * verify. Implementations should be best-effort — a write
   * failure here MUST NOT prevent the user from signing in (the
   * verify already passed), but should be logged.
   *
   * `secretId` is the specific admin_mfa_secrets row that matched.
   * Optional for backwards-compat with single-device implementations
   * (the user-scoped update still works for them).
   */
  recordVerify(
    userId: string,
    counter: number,
    secretId?: string,
  ): Promise<void>;
  /**
   * Recovery-code branch — look up a SPENDABLE (used_at IS NULL)
   * recovery code by its SHA-256 hash, restricted to the given
   * staff user. Returns the row id when found, null otherwise. The
   * verify handler calls this when the SPA submits a recovery code
   * in place of a TOTP code.
   *
   * Optional so artifacts that haven't shipped recovery codes yet
   * can leave this unimplemented; the verify handler treats a
   * missing method as "recovery branch disabled."
   */
  findRecoveryCodeMatch?(
    userId: string,
    codeHash: string,
  ): Promise<{ id: string } | null>;
  /**
   * Mark a recovery code row as spent. Sets used_at = now() and
   * used_ip = `ip` if supplied. Best-effort — like recordVerify,
   * a write failure MUST NOT block sign-in (the user typed a
   * valid, one-time code; the worst case is that the same code
   * could be replayed, which the matching `findRecoveryCodeMatch`
   * already gates on used_at IS NULL — so a write failure means
   * the next attempt would also succeed, which is the rare correct
   * recovery-from-DB-blip behaviour).
   *
   * Optional alongside `findRecoveryCodeMatch`.
   */
  markRecoveryCodeUsed?(rowId: string, ip: string | null): Promise<void>;
}

export interface MfaProbeSecret {
  secretBase32: string;
  /** Previously-used counter, null on first verify after enrollment. */
  lastUsedCounter: number | null;
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
