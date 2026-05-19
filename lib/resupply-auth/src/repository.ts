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
// (`pgAuthRepository(pool)`) used to live here. It was retired in
// the Drizzle → Supabase migration. Every runtime path now goes
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
  }): Promise<void>;

  findSessionByTokenHash(tokenHash: Buffer): Promise<AuthSession | null>;
  insertSession(input: {
    tokenHash: Buffer;
    userId: string;
    expiresAt: Date;
    ip: string | null;
    userAgentHash: Buffer | null;
  }): Promise<AuthSession>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
  revokeAllUserSessions(userId: string, at: Date): Promise<void>;
  revokeOtherUserSessions(
    userId: string,
    exceptSessionId: string,
    at: Date,
  ): Promise<void>;
  bumpSession(sessionId: string, expiresAt: Date, at: Date): Promise<void>;

  insertEmailToken(input: {
    tokenHash: Buffer;
    userId: string;
    purpose: EmailTokenPurpose;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Atomically consume an email token: returns the row if it was
   * still valid (unconsumed AND not expired) at the time of the
   * call AND marks it consumed, otherwise returns null. The
   * atomicity matters — a concurrent double-click can't redeem the
   * same token twice.
   */
  consumeEmailToken(input: {
    tokenHash: Buffer;
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
