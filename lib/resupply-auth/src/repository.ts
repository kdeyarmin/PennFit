// Repository layer for the in-house auth tables.
//
// This file defines the abstract `AuthRepository` interface plus the
// row-shape types that flow through it. The production implementation
// lives in `./supabase-repository.ts` (wired into the API via
// `getAuthDeps()` in artifacts/resupply-api/src/lib/auth-deps.ts);
// unit tests use a fake repo that satisfies the same interface
// without spinning up a real backend.
//
// History note: a Postgres-backed implementation
// (`pgAuthRepository(pool)`) used to live here. It was retired when
// the auth layer moved to Supabase. Every runtime path now goes
// through Supabase's PostgREST surface via the supabase-repository
// implementation, so the pg-based factory + its 30 internal SQL
// helpers were removed. See git history if you need to reconstruct
// the SQL shape for a future audit.

import type {
  AuthRole,
  AuthUserStatus,
  EmailTokenPurpose,
} from "@workspace/resupply-db";

export interface AuthUser {
  id: string;
  emailLower: string;
  displayName: string | null;
  role: AuthRole;
  status: AuthUserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PasswordCredential {
  userId: string;
  passwordHash: string;
  algo: string;
  mustChange: boolean;
  /**
   * Timestamp captured when an operator typed this password ON
   * BEHALF of the user via the team-invite "Set their password for
   * them" flow. NULL for user-set passwords (sign-up / reset /
   * change-password) and for legacy Clerk-cutover rows. Pairs with
   * `mustChange=true` to let the sign-in handler expire stale
   * operator-typed credentials whose owner never signed in.
   */
  setByAdminAt: Date | null;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  issuedAt: Date;
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgentHash: Buffer | null;
  /**
   * Platform-admin impersonation (G4). When non-null, this session is a
   * platform super-admin acting AS the tenant `impersonatedOrgId`; the
   * admin gate binds the request to that org instead of the session
   * owner's own tenant. NULL for every normal session.
   */
  impersonatedOrgId: string | null;
  /** The platform admin's `auth.users.id` behind an impersonation session. */
  impersonatorUserId: string | null;
  /**
   * Provider portal active DME (migration 0533). When non-null on a
   * platform-host request (no brand org), queue/RTM may use this org after
   * re-validating an active provider_dme_links row. Distinct from
   * impersonatedOrgId — never read by admin gates.
   */
  providerActiveOrgId: string | null;
}

export interface AuthEmailTokenRow {
  tokenHash: Buffer;
  userId: string;
  purpose: EmailTokenPurpose;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface AuthRepository {
  findUserByEmail(emailLower: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  insertUser(input: {
    emailLower: string;
    displayName: string | null;
    role: AuthRole;
    status: AuthUserStatus;
  }): Promise<AuthUser>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  updateUserStatus(userId: string, status: AuthUserStatus): Promise<void>;

  findCredentialByUserId(userId: string): Promise<PasswordCredential | null>;
  upsertCredential(input: {
    userId: string;
    passwordHash: string;
    mustChange?: boolean;
    /**
     * Explicit timestamp for `set_by_admin_at`. Pass a Date when an
     * operator is typing this password on behalf of the user (team
     * invite "set their password for them"); pass `null` to clear
     * the column when the user replaces the operator-typed password
     * themselves (sign-up / reset-password / change-password). Pass
     * `undefined` (omit) when the caller intends to preserve the
     * existing value — used by sign-in's transparent algorithm
     * upgrade path, which must not turn a stale operator credential
     * back into a fresh one.
     */
    setByAdminAt?: Date | null;
  }): Promise<void>;

  findSessionByTokenHash(tokenHash: Buffer): Promise<AuthSession | null>;
  insertSession(input: {
    tokenHash: Buffer;
    userId: string;
    expiresAt: Date;
    ip: string | null;
    userAgentHash: Buffer | null;
    /** Set both to mint a platform-admin impersonation session (G4). */
    impersonatedOrgId?: string | null;
    impersonatorUserId?: string | null;
  }): Promise<AuthSession>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
  revokeAllUserSessions(userId: string, at: Date): Promise<void>;
  revokeOtherUserSessions(
    userId: string,
    exceptSessionId: string,
    at: Date,
  ): Promise<void>;
  bumpSession(sessionId: string, expiresAt: Date, at: Date): Promise<void>;
  /**
   * Pin or clear the provider portal's active DME org on an existing
   * session. Pass null to clear. Does not mint a new session.
   */
  setProviderActiveOrgId(
    sessionId: string,
    orgId: string | null,
  ): Promise<void>;
  findSessionById(sessionId: string): Promise<AuthSession | null>;

  insertEmailToken(input: {
    tokenHash: Buffer;
    userId: string;
    purpose: EmailTokenPurpose;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Expire every still-valid (unconsumed, unexpired) email token a
   * user holds for one purpose. Called right before issuing a fresh
   * token so repeat forgot-password / re-send-verification requests
   * don't leave a stack of concurrently valid links in old emails —
   * only the most recently issued link works.
   */
  expireUnconsumedEmailTokens(input: {
    userId: string;
    purpose: EmailTokenPurpose;
    at: Date;
  }): Promise<void>;
  /**
   * Atomically consume an email token: returns the row if it was
   * still valid (unconsumed AND not expired) at the time of the
   * call AND matched the expected purpose AND marks it consumed,
   * otherwise returns null. The atomicity matters — a concurrent
   * double-click can't redeem the same token twice. The purpose is
   * part of the consume predicate (not checked after) so a valid
   * token POSTed to the WRONG endpoint (a signup_verify token to
   * /auth/reset-password, or vice versa) misses the WHERE clause and
   * stays redeemable at the right endpoint instead of being burned.
   */
  consumeEmailToken(input: {
    tokenHash: Buffer;
    purpose: EmailTokenPurpose;
    at: Date;
  }): Promise<AuthEmailTokenRow | null>;

  recordLoginAttempt(input: {
    emailLower: string;
    ip: string | null;
    success: boolean;
  }): Promise<void>;
  countRecentFailures(input: {
    emailLower: string | null;
    ip: string | null;
    sinceMs: number;
  }): Promise<number>;
}

// Re-export types from resupply-db so handler code only ever
// imports from `@workspace/resupply-auth`. Keeps the dependency
// graph one-way.
export type { EmailTokenPurpose };
