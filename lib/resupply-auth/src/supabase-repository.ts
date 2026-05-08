// Supabase-backed implementation of `AuthRepository`.
//
// Phase 2 of the lib/resupply-auth Drizzle/pg → Supabase port.
// `pgAuthRepository` in `./repository.ts` is still the production
// implementation and remains the canonical source of truth for SQL
// shapes; this file mirrors it on the Supabase JS client and lets a
// route author opt in by injecting it.
//
// Bytea columns (sessions.token_hash, sessions.user_agent_hash,
// email_tokens.token_hash) round-trip through the helpers in
// `./bytea.ts` — Buffer → `\x<hex>` JSON string on the way in,
// the same shape back on the way out. The wire format is exercised
// in `bytea.test.ts`.
//
// `consumeEmailToken` is implemented as a single
// `UPDATE ... WHERE token_hash = $1 AND consumed_at IS NULL AND
// expires_at > $2 RETURNING ...` via PostgREST. That's one statement
// inside one Postgres transaction, so MVCC + row locking gives us
// the same atomic-claim semantics the original SQL had — concurrent
// callers serialize on the row, only the first one matches the
// `consumed_at IS NULL` predicate, the rest miss the WHERE and
// return zero rows. No RPC needed.
//
// What still delegates to pg: nothing.

import type { Pool } from "pg";

import type {
  AuthRole,
  AuthUserStatus,
  EmailTokenPurpose,
  ResupplySupabaseClient,
} from "@workspace/resupply-db";

import {
  bufferToHexBytea,
  bufferToHexByteaOrNull,
  hexByteaToBuffer,
  hexByteaToBufferOrNull,
} from "./bytea.js";
import type {
  AuthEmailTokenRow,
  AuthRepository,
  AuthSession,
  AuthUser,
  PasswordCredential,
} from "./repository.js";
import { pgAuthRepository as _pgAuthRepository } from "./repository.js";

interface UserRow {
  id: string;
  email_lower: string;
  display_name: string | null;
  role: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    emailLower: row.email_lower,
    displayName: row.display_name,
    role: row.role as AuthRole,
    status: row.status as AuthUserStatus,
    emailVerifiedAt: row.email_verified_at ? new Date(row.email_verified_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  issued_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  ip: string | null;
  user_agent_hash: string | null;
}

function rowToSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    issuedAt: new Date(row.issued_at),
    expiresAt: new Date(row.expires_at),
    lastSeenAt: new Date(row.last_seen_at),
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
    ip: row.ip,
    userAgentHash: hexByteaToBufferOrNull(row.user_agent_hash),
  };
}

interface EmailTokenRow {
  token_hash: string;
  user_id: string;
  purpose: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

function rowToEmailToken(row: EmailTokenRow): AuthEmailTokenRow {
  return {
    tokenHash: hexByteaToBuffer(row.token_hash),
    userId: row.user_id,
    purpose: row.purpose as EmailTokenPurpose,
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
    createdAt: new Date(row.created_at),
  };
}

const USER_COLS =
  "id, email_lower, display_name, role, status, email_verified_at, created_at, updated_at";
const CRED_COLS = "user_id, password_hash, algo, must_change, updated_at";
const SESSION_COLS =
  "id, user_id, issued_at, expires_at, last_seen_at, revoked_at, ip, user_agent_hash";
const EMAIL_TOKEN_COLS =
  "token_hash, user_id, purpose, expires_at, consumed_at, created_at";

export function supabaseAuthRepository(
  supabase: ResupplySupabaseClient,
  // Reserved for a future emergency fallback (e.g. the Supabase API
  // is unreachable but DATABASE_URL still works). Currently unused —
  // every method is on Supabase.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _fallback?: Pool,
): AuthRepository {
  return {
    async findUserByEmail(emailLower) {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select(USER_COLS)
        .eq("email_lower", emailLower)
        .limit(1)
        .maybeSingle<UserRow>();
      if (error) throw error;
      return data ? rowToUser(data) : null;
    },

    async findUserById(id) {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select(USER_COLS)
        .eq("id", id)
        .limit(1)
        .maybeSingle<UserRow>();
      if (error) throw error;
      return data ? rowToUser(data) : null;
    },

    async insertUser(input) {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .insert({
          email_lower: input.emailLower,
          display_name: input.displayName,
          role: input.role,
          status: input.status,
        })
        .select(USER_COLS)
        .single<UserRow>();
      if (error) throw error;
      return rowToUser(data);
    },

    async markEmailVerified(userId, at) {
      const iso = at.toISOString();
      // Two-step (read-then-write) is fine: email_verified is
      // monotonic (once stamped it never reverts), and the
      // status="invited" → "active" transition is also one-way. A
      // concurrent caller that loses the race writes the same
      // values; the second writer's ON CONFLICT-style guard isn't
      // needed because there's no useful different value to write.
      const { data: existing, error: readErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .select("email_verified_at, status")
        .eq("id", userId)
        .limit(1)
        .maybeSingle<{ email_verified_at: string | null; status: string }>();
      if (readErr) throw readErr;
      if (!existing) return;

      const updates: { email_verified_at?: string; status?: string; updated_at: string } = {
        updated_at: iso,
      };
      if (existing.email_verified_at == null) updates.email_verified_at = iso;
      if (existing.status === "invited") updates.status = "active";

      const { error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update(updates)
        .eq("id", userId);
      if (error) throw error;
    },

    async updateUserStatus(userId, status) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", userId);
      if (error) throw error;
    },

    async findCredentialByUserId(userId): Promise<PasswordCredential | null> {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("password_credentials")
        .select(CRED_COLS)
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle<{
          user_id: string;
          password_hash: string;
          algo: string;
          must_change: boolean;
          updated_at: string;
        }>();
      if (error) throw error;
      if (!data) return null;
      return {
        userId: data.user_id,
        passwordHash: data.password_hash,
        algo: data.algo,
        mustChange: data.must_change,
        updatedAt: new Date(data.updated_at),
      };
    },

    async upsertCredential(input) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("password_credentials")
        .upsert(
          {
            user_id: input.userId,
            password_hash: input.passwordHash,
            must_change: input.mustChange ?? false,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },

    async findSessionByTokenHash(tokenHash) {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .select(SESSION_COLS)
        .eq("token_hash", bufferToHexBytea(tokenHash))
        .limit(1)
        .maybeSingle<SessionRow>();
      if (error) throw error;
      return data ? rowToSession(data) : null;
    },

    async insertSession(input) {
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .insert({
          token_hash: bufferToHexBytea(input.tokenHash),
          user_id: input.userId,
          expires_at: input.expiresAt.toISOString(),
          ip: input.ip,
          user_agent_hash: bufferToHexByteaOrNull(input.userAgentHash),
        })
        .select(SESSION_COLS)
        .single<SessionRow>();
      if (error) throw error;
      return rowToSession(data);
    },

    async revokeSession(sessionId, at) {
      // Match the original WHERE: don't clobber an already-revoked
      // row's revoked_at (.is("revoked_at", null) keeps the predicate).
      const { error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .update({ revoked_at: at.toISOString() })
        .eq("id", sessionId)
        .is("revoked_at", null);
      if (error) throw error;
    },

    async revokeAllUserSessions(userId, at) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .update({ revoked_at: at.toISOString() })
        .eq("user_id", userId)
        .is("revoked_at", null);
      if (error) throw error;
    },

    async revokeOtherUserSessions(userId, exceptSessionId, at) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .update({ revoked_at: at.toISOString() })
        .eq("user_id", userId)
        .neq("id", exceptSessionId)
        .is("revoked_at", null);
      if (error) throw error;
    },

    async bumpSession(sessionId, expiresAt, at) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("sessions")
        .update({
          expires_at: expiresAt.toISOString(),
          last_seen_at: at.toISOString(),
        })
        .eq("id", sessionId)
        .is("revoked_at", null);
      if (error) throw error;
    },

    async insertEmailToken(input) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("email_tokens")
        .insert({
          token_hash: bufferToHexBytea(input.tokenHash),
          user_id: input.userId,
          purpose: input.purpose,
          expires_at: input.expiresAt.toISOString(),
        });
      if (error) throw error;
    },

    async consumeEmailToken(input) {
      // Single-statement UPDATE ... WHERE ... RETURNING is atomic at
      // the row level: concurrent callers serialize on Postgres's
      // row lock, only the first one matches `consumed_at IS NULL`,
      // the rest miss the WHERE clause and return an empty array.
      // No RPC needed.
      const iso = input.at.toISOString();
      const { data, error } = await supabase
        .schema("resupply_auth")
        .from("email_tokens")
        .update({ consumed_at: iso })
        .eq("token_hash", bufferToHexBytea(input.tokenHash))
        .is("consumed_at", null)
        .gt("expires_at", iso)
        .select(EMAIL_TOKEN_COLS)
        .maybeSingle<EmailTokenRow>();
      if (error) throw error;
      return data ? rowToEmailToken(data) : null;
    },

    async recordLoginAttempt(input) {
      const { error } = await supabase
        .schema("resupply_auth")
        .from("login_attempts")
        .insert({
          email_lower: input.emailLower,
          ip: input.ip,
          success: input.success,
        });
      if (error) throw error;
    },

    async countRecentFailures(input) {
      const since = new Date(Date.now() - input.sinceMs).toISOString();
      // Original predicate is "(email matches OR ip matches)" — the
      // caller passes one or the other (or both) and we OR them.
      // PostgREST's `.or()` takes a comma-separated filter string;
      // each clause is `<col>.<op>.<value>`. Both inputs are
      // server-controlled sentinels (admin email lower-case / a
      // request IP); they cannot embed PostgREST metacharacters.
      const ors: string[] = [];
      if (input.emailLower) ors.push(`email_lower.eq.${input.emailLower}`);
      if (input.ip) ors.push(`ip.eq.${input.ip}`);
      if (ors.length === 0) return 0;
      const { count, error } = await supabase
        .schema("resupply_auth")
        .from("login_attempts")
        .select("id", { count: "exact", head: true })
        .eq("success", false)
        .gte("attempted_at", since)
        .or(ors.join(","));
      if (error) throw error;
      return count ?? 0;
    },
  };
}
