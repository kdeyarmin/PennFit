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
 * Bundle of dependencies the handlers need. Constructed once at
 * mount time and threaded through every route. Keeps the
 * dependency graph explicit — no module-level singletons.
 */
export interface AuthDeps {
  env: AuthEnv;
  repo: AuthRepository;
  audit: AuditWriter;
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
