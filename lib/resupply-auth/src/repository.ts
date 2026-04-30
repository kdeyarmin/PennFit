// Repository layer for the in-house auth tables.
//
// Every read or write that touches `auth.*` goes through this file.
// Two reasons:
//   1. The handler layer (./http/*) shouldn't import drizzle / pg
//      directly — that lets us unit-test handler logic with a fake
//      repo without spinning up Postgres.
//   2. SQL has gravity. Centralizing it here means schema changes
//      land in one place.
//
// We deliberately use raw `pg` queries (not Drizzle) here:
//   * The schemas in `lib/resupply-db/src/schema/auth/` are the
//     single source of truth for column names; this module just
//     reads/writes them. A small SQL surface is easier to audit
//     for "does this leak password_hash?" than Drizzle's
//     dynamic-query builder.
//   * Drizzle's bytea handling and inet handling sit behind
//     custom types — going through raw pg keeps the bytea /
//     timestamp / inet round-trip explicit.

import type { Pool, PoolClient } from "pg";

import type { EmailTokenPurpose } from "@workspace/resupply-db";

import type { AuthRole, AuthUserStatus } from "@workspace/resupply-db";

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

export interface AuthRepository {
  findUserByEmail(emailLower: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  findCredentialByUserId(userId: string): Promise<PasswordCredential | null>;

  findSessionByTokenHash(
    tokenHash: Buffer,
  ): Promise<AuthSession | null>;
  insertSession(input: {
    tokenHash: Buffer;
    userId: string;
    expiresAt: Date;
    ip: string | null;
    userAgentHash: Buffer | null;
  }): Promise<AuthSession>;
  revokeSession(sessionId: string, at: Date): Promise<void>;
  bumpSession(sessionId: string, expiresAt: Date, at: Date): Promise<void>;

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

/**
 * Build a Postgres-backed AuthRepository over the supplied pool.
 * The pool is supplied (not imported) so callers can pass either
 * `getDbPool()` from `@workspace/resupply-db` or a test pool from
 * `lib/resupply-testing`.
 */
export function pgAuthRepository(pool: Pool): AuthRepository {
  return {
    findUserByEmail: (emailLower) => findUserByEmail(pool, emailLower),
    findUserById: (id) => findUserById(pool, id),
    findCredentialByUserId: (userId) => findCredentialByUserId(pool, userId),
    findSessionByTokenHash: (hash) => findSessionByTokenHash(pool, hash),
    insertSession: (input) => insertSession(pool, input),
    revokeSession: (id, at) => revokeSession(pool, id, at),
    bumpSession: (id, expiresAt, at) => bumpSession(pool, id, expiresAt, at),
    recordLoginAttempt: (input) => recordLoginAttempt(pool, input),
    countRecentFailures: (input) => countRecentFailures(pool, input),
  };
}

// ---- internals -----------------------------------------------------------

type Queryable = Pool | PoolClient;

interface UserRow {
  id: string;
  email_lower: string;
  display_name: string | null;
  role: string;
  status: string;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    emailLower: row.email_lower,
    displayName: row.display_name,
    role: row.role as AuthRole,
    status: row.status as AuthUserStatus,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findUserByEmail(
  q: Queryable,
  emailLower: string,
): Promise<AuthUser | null> {
  const { rows } = await q.query<UserRow>(
    `SELECT id, email_lower, display_name, role, status,
            email_verified_at, created_at, updated_at
       FROM auth.users
      WHERE email_lower = $1
      LIMIT 1`,
    [emailLower],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function findUserById(
  q: Queryable,
  id: string,
): Promise<AuthUser | null> {
  const { rows } = await q.query<UserRow>(
    `SELECT id, email_lower, display_name, role, status,
            email_verified_at, created_at, updated_at
       FROM auth.users
      WHERE id = $1
      LIMIT 1`,
    [id],
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

interface CredRow {
  user_id: string;
  password_hash: string;
  algo: string;
  must_change: boolean;
  updated_at: Date;
}

async function findCredentialByUserId(
  q: Queryable,
  userId: string,
): Promise<PasswordCredential | null> {
  const { rows } = await q.query<CredRow>(
    `SELECT user_id, password_hash, algo, must_change, updated_at
       FROM auth.password_credentials
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    passwordHash: row.password_hash,
    algo: row.algo,
    mustChange: row.must_change,
    updatedAt: row.updated_at,
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  issued_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent_hash: Buffer | null;
}

function rowToSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    ip: row.ip,
    userAgentHash: row.user_agent_hash,
  };
}

async function findSessionByTokenHash(
  q: Queryable,
  hash: Buffer,
): Promise<AuthSession | null> {
  const { rows } = await q.query<SessionRow>(
    `SELECT id, user_id, issued_at, expires_at, last_seen_at,
            revoked_at, ip::text AS ip, user_agent_hash
       FROM auth.sessions
      WHERE token_hash = $1
      LIMIT 1`,
    [hash],
  );
  return rows[0] ? rowToSession(rows[0]) : null;
}

async function insertSession(
  q: Queryable,
  input: {
    tokenHash: Buffer;
    userId: string;
    expiresAt: Date;
    ip: string | null;
    userAgentHash: Buffer | null;
  },
): Promise<AuthSession> {
  const { rows } = await q.query<SessionRow>(
    `INSERT INTO auth.sessions
       (token_hash, user_id, expires_at, ip, user_agent_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, issued_at, expires_at, last_seen_at,
               revoked_at, ip::text AS ip, user_agent_hash`,
    [
      input.tokenHash,
      input.userId,
      input.expiresAt,
      input.ip,
      input.userAgentHash,
    ],
  );
  return rowToSession(rows[0]!);
}

async function revokeSession(
  q: Queryable,
  sessionId: string,
  at: Date,
): Promise<void> {
  await q.query(
    `UPDATE auth.sessions
        SET revoked_at = $2
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId, at],
  );
}

async function bumpSession(
  q: Queryable,
  sessionId: string,
  expiresAt: Date,
  at: Date,
): Promise<void> {
  await q.query(
    `UPDATE auth.sessions
        SET expires_at = $2,
            last_seen_at = $3
      WHERE id = $1
        AND revoked_at IS NULL`,
    [sessionId, expiresAt, at],
  );
}

async function recordLoginAttempt(
  q: Queryable,
  input: { emailLower: string; ip: string | null; success: boolean },
): Promise<void> {
  await q.query(
    `INSERT INTO auth.login_attempts (email_lower, ip, success)
     VALUES ($1, $2, $3)`,
    [input.emailLower, input.ip, input.success],
  );
}

async function countRecentFailures(
  q: Queryable,
  input: {
    emailLower: string | null;
    ip: string | null;
    sinceMs: number;
  },
): Promise<number> {
  // OR'd: either the email matches OR the IP matches. The caller
  // decides which limiter to interpret the count against.
  const { rows } = await q.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM auth.login_attempts
      WHERE success = false
        AND attempted_at > NOW() - ($1::int || ' milliseconds')::interval
        AND (
          ($2::text IS NOT NULL AND email_lower = $2)
          OR ($3::inet IS NOT NULL AND ip = $3)
        )`,
    [input.sinceMs, input.emailLower, input.ip],
  );
  return Number(rows[0]?.count ?? "0");
}

// Re-export types from resupply-db so handler code only ever
// imports from `@workspace/resupply-auth`. Keeps the dependency
// graph one-way.
export type { EmailTokenPurpose };
