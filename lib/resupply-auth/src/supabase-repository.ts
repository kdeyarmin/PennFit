// Supabase-backed implementation of `AuthRepository`.
//
// Phase 1 of the lib/resupply-auth Drizzle/pg → Supabase port. The
// `pgAuthRepository` in `./repository.ts` is still the production
// implementation and remains the canonical source of truth for SQL
// shapes; this file ports the *read-only, non-bytea* helpers as a
// pattern demonstrator and lets a route author opt in by injecting
// it instead of pgAuthRepository.
//
// What's NOT here yet (and why):
//
// * Anything touching `token_hash` or `user_agent_hash` (sessions +
//   email_tokens + login_attempts.ip-via-inet). Postgres `bytea`
//   round-trips through Supabase JS as the literal `\x...` hex
//   escape on the way in and a base64 string on the way out, which
//   is a foot-gun for token-equality semantics. Sessions in
//   particular MUST NOT mis-encode — a single corrupted byte would
//   silently invalidate every cookie the worker has issued. That
//   port belongs in its own PR with golden-vector tests.
//
// * `consumeEmailToken` — the helper's contract is "atomic claim:
//   first concurrent caller wins, rest see null." PostgREST exposes
//   UPDATE...RETURNING but the at-most-once semantics are easier to
//   reason about as a server-side function called via
//   `supabase.rpc(...)`. We'll add the RPC alongside the bytea port.
//
// * `revokeAllUserSessions` / `revokeOtherUserSessions` — same
//   sessions-table reservation as above.
//
// What IS here: simple key-eq SELECTs and column-only UPDATEs that
// don't cross the bytea boundary. These are safe and demonstrate
// the shape of the larger port.

import type { Pool } from "pg";

import type {
  AuthRole,
  AuthUserStatus,
  ResupplySupabaseClient,
} from "@workspace/resupply-db";

import type {
  AuthRepository,
  AuthUser,
  PasswordCredential,
} from "./repository.js";
import { pgAuthRepository } from "./repository.js";

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

const USER_COLS =
  "id, email_lower, display_name, role, status, email_verified_at, created_at, updated_at";
const CRED_COLS = "user_id, password_hash, algo, must_change, updated_at";

export function supabaseAuthRepository(
  supabase: ResupplySupabaseClient,
  // Fallback pg pool for the methods this port hasn't reached yet.
  // See header comment for what's deferred and why.
  fallback: Pool,
): AuthRepository {
  const pg = pgAuthRepository(fallback);

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
      // Two-step (read-then-write) is fine because email-verified is
      // monotonic: once stamped it never reverts. The read-then-CASE
      // expression in the original SQL preserves the earliest
      // verification time; we mirror that by reading first and only
      // writing the new timestamp when the column is null.
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
      if (Object.keys(updates).length === 1) return; // only updated_at

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
      let query = supabase
        .schema("resupply_auth")
        .from("login_attempts")
        .select("id", { count: "exact", head: true })
        .eq("success", false)
        .gte("attempted_at", since);
      if (input.emailLower) query = query.eq("email_lower", input.emailLower);
      if (input.ip) query = query.eq("ip", input.ip);
      const { count, error } = await query;
      if (error) throw error;
      return count ?? 0;
    },

    // ── Deferred to phase 2 (bytea + atomic-claim semantics). ────────
    // These delegate to the existing pg implementation so the
    // repository as a whole stays usable while the port is in flight.
    findSessionByTokenHash: pg.findSessionByTokenHash,
    insertSession: pg.insertSession,
    revokeSession: pg.revokeSession,
    revokeAllUserSessions: pg.revokeAllUserSessions,
    revokeOtherUserSessions: pg.revokeOtherUserSessions,
    bumpSession: pg.bumpSession,
    insertEmailToken: pg.insertEmailToken,
    consumeEmailToken: pg.consumeEmailToken,
  };
}
