-- 0356_session_impersonation — platform-admin act-as-tenant support (G4).
--
-- Adds two nullable columns to resupply_auth.sessions so a session can
-- carry an IMPERSONATION context: a platform super-admin (G4, migration
-- 0355) acting as a tenant for support.
--
--   * impersonated_org_id — the tenant the session is acting AS. When set,
--     `requireAdmin` binds the request to THIS org (not the impersonator's
--     own admin_users.org_id) and grants tenant-admin access there.
--   * impersonator_user_id — the platform admin's auth.users.id, recorded
--     so every action under impersonation is attributable to a real human.
--
-- A normal session leaves both NULL and behaves exactly as before — this
-- is purely additive and changes nothing for non-impersonation traffic.
-- The columns are read on the existing per-request `findSessionByTokenHash`
-- SELECT (no extra round-trip).
--
-- No cross-schema FKs (matching the resupply_auth.*.auth_user_id
-- convention): impersonated_org_id references resupply.organizations(id)
-- and impersonator_user_id references resupply_auth.users(id) only by
-- value. The impersonate endpoint (gated by requirePlatformAdmin) is the
-- only writer; sessions are short-lived and revocable.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply_auth"."sessions"
  ADD COLUMN IF NOT EXISTS "impersonated_org_id" uuid,
  ADD COLUMN IF NOT EXISTS "impersonator_user_id" text;
--> statement-breakpoint

-- Partial index so "list active impersonation sessions" / cleanup stays
-- cheap; the common case (NULL) is excluded from the index entirely.
CREATE INDEX IF NOT EXISTS "auth_sessions_impersonation_idx"
  ON "resupply_auth"."sessions" ("impersonated_org_id")
  WHERE "impersonated_org_id" IS NOT NULL;
