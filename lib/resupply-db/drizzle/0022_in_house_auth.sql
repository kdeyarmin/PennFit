-- 0022_in_house_auth — in-house authentication schema.
--
-- Stage 1 of the Clerk → in-house migration. See ADR 014 and
-- docs/resupply/AUTH-MIGRATION-PLAN.md.
--
-- This migration is additive: it creates the `auth` schema and
-- five tables, plus nullable `auth_user_id` columns on
-- `resupply.admin_users` and `resupply.shop_customers`. No existing
-- column or constraint is dropped here. The Clerk path remains the
-- live auth path until `AUTH_PROVIDER` is flipped (Stage 3 / 4).
--
-- Why a separate `auth` schema (not `resupply.*`):
--   * Privilege boundary. Future DB roles can be granted SELECT on
--     `resupply.*` while being denied any access to
--     `resupply_auth.password_credentials` or `resupply_auth.sessions`.
--   * Lifecycle. The auth tables are owned by `lib/resupply-auth`;
--     keeping them out of `resupply.*` makes the ownership obvious
--     in greps and in `\dt`.
--
-- Why no DELETE-on-revoke for sessions / login_attempts:
--   * `resupply_auth.sessions.revoked_at` is the audit trail of "this token
--     was invalidated, here's when". A DELETE would lose that.
--   * `resupply_auth.login_attempts` is append-only by design (rate limiting
--     + post-incident lookups). Old rows are pruned by a separate
--     job, not by the sign-in path.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE SCHEMA IF NOT EXISTS "resupply_auth";

-- ---------------------------------------------------------------------------
-- resupply_auth.users — canonical identity row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "resupply_auth"."users" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  -- Lowercased + trimmed by the application before insert. UNIQUE
  -- enforces "one user per address". NOT a citext column — we keep
  -- normalization in app code so Postgres extensions don't become a
  -- deploy dependency.
  "email_lower" text NOT NULL UNIQUE,
  "display_name" text,
  -- 'customer' | 'agent' | 'admin'.
  "role" text NOT NULL DEFAULT 'customer',
  -- 'active' | 'invited' | 'locked' | 'revoked'.
  --
  -- 'invited' is the initial state for staff added via the team
  -- page (no password yet) and for shop customers backfilled from
  -- Clerk during the Stage 4 cutover. They graduate to 'active'
  -- when they consume their set-password / verify-email token.
  "status" text NOT NULL DEFAULT 'invited',
  -- Set when a verification token has been consumed. NULL means
  -- the user has not proven control of this address; sign-in
  -- refuses unverified accounts.
  "email_verified_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "auth_users_role_idx"
  ON "resupply_auth"."users" ("role");
CREATE INDEX IF NOT EXISTS "auth_users_status_idx"
  ON "resupply_auth"."users" ("status");

-- ---------------------------------------------------------------------------
-- resupply_auth.password_credentials — argon2id-hashed passwords.
-- ---------------------------------------------------------------------------
-- Split out from `resupply_auth.users` so a future read-only role can be
-- granted SELECT on the user roster without ever being able to
-- read password material.
CREATE TABLE IF NOT EXISTS "resupply_auth"."password_credentials" (
  "user_id" text PRIMARY KEY REFERENCES "resupply_auth"."users"("id") ON DELETE CASCADE,
  -- Encoded argon2id string (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`).
  -- Includes the params the hash was generated with, so we can
  -- detect drift and re-hash on next login when our target
  -- parameters move.
  "password_hash" text NOT NULL,
  -- Forward-compatible algorithm tag.
  "algo" text NOT NULL DEFAULT 'argon2id-v1',
  -- If true, the user is forced through /reset-password on next
  -- sign-in. Used during the Clerk cutover (Stage 4) and for
  -- staff-set temporary passwords.
  "must_change" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- resupply_auth.sessions — opaque server-issued session tokens.
-- ---------------------------------------------------------------------------
-- We persist `sha256(rawToken)` only — the raw bytes never touch
-- the database. A DB leak therefore does not yield session
-- hijacking material.
CREATE TABLE IF NOT EXISTS "resupply_auth"."sessions" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "token_hash" bytea NOT NULL UNIQUE,
  "user_id" text NOT NULL REFERENCES "resupply_auth"."users"("id") ON DELETE CASCADE,
  "issued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- NULL while the session is live. Sign-out / sign-out-all /
  -- password-change all set this to now().
  "revoked_at" timestamp with time zone,
  -- Best-effort observability. Never trusted for auth decisions.
  "ip" inet,
  "user_agent_hash" bytea
);

-- The sign-in middleware looks up by token_hash on every request,
-- and the "list my sessions" endpoint scans by user_id with
-- revoked_at IS NULL. The token_hash UNIQUE is auto-indexed.
CREATE INDEX IF NOT EXISTS "auth_sessions_user_idx"
  ON "resupply_auth"."sessions" ("user_id", "revoked_at");
-- Background pruning of expired sessions scans by expires_at.
CREATE INDEX IF NOT EXISTS "auth_sessions_expires_idx"
  ON "resupply_auth"."sessions" ("expires_at");

-- ---------------------------------------------------------------------------
-- resupply_auth.email_tokens — single-use tokens delivered via email.
-- ---------------------------------------------------------------------------
-- Purposes: 'signup_verify', 'password_reset', 'email_change'.
-- We persist `sha256(rawToken)` only; the raw token lives only in
-- the outbound email URL. Setting `consumed_at` marks a token
-- used — we never DELETE so the audit trail is preserved.
CREATE TABLE IF NOT EXISTS "resupply_auth"."email_tokens" (
  "token_hash" bytea PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "resupply_auth"."users"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "auth_email_tokens_user_purpose_idx"
  ON "resupply_auth"."email_tokens" ("user_id", "purpose");

-- ---------------------------------------------------------------------------
-- resupply_auth.login_attempts — append-only sign-in attempt log.
-- ---------------------------------------------------------------------------
-- Drives both rate limiting and the post-incident "did anyone
-- actually sign in as alice@example.com?" investigation question.
-- We never log password bytes or hashes here.
CREATE TABLE IF NOT EXISTS "resupply_auth"."login_attempts" (
  "id" bigserial PRIMARY KEY,
  "email_lower" text NOT NULL,
  "ip" inet,
  "success" boolean NOT NULL,
  "attempted_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "auth_login_attempts_email_idx"
  ON "resupply_auth"."login_attempts" ("email_lower", "attempted_at");
CREATE INDEX IF NOT EXISTS "auth_login_attempts_ip_idx"
  ON "resupply_auth"."login_attempts" ("ip", "attempted_at");

-- ---------------------------------------------------------------------------
-- Link columns on existing tables.
-- ---------------------------------------------------------------------------
-- `auth_user_id` lets the in-house auth row coexist with the
-- existing Clerk user id column during the dual-auth cutover. Both
-- nullable so backfill / migration can happen lazily; the FK
-- ensures we can't end up with a dangling reference once we cut
-- over.

ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "auth_user_id" text
    REFERENCES "resupply_auth"."users"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_auth_user_id_idx"
  ON "resupply"."admin_users" ("auth_user_id")
  WHERE "auth_user_id" IS NOT NULL;

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "auth_user_id" text
    REFERENCES "resupply_auth"."users"("id") ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "shop_customers_auth_user_id_idx"
  ON "resupply"."shop_customers" ("auth_user_id")
  WHERE "auth_user_id" IS NOT NULL;
