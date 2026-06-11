-- Patient portal invite — links a patient row to an auth.users identity
-- so the patient can log in to self-serve their account.
--
-- Why ALTER TABLE rather than a new table: the invite state is a 1:1
-- property of the patient row (one auth account per patient) and the
-- columns are rarely read — only the admin detail panel and the
-- GET /patients/:id response touch them.
--
-- portal_auth_user_id is a soft FK (text, not UUID FK) to auth.users.id
-- matching the pattern used by admin_users.auth_user_id. A hard FK
-- would couple schema migrations across two schemas unnecessarily.
--
-- portal_status is intentionally NOT stored — it is derived at query
-- time from portal_auth_user_id + auth.users.email_verified_at:
--   NULL auth_user_id          → 'not_invited'
--   auth_user_id + unverified  → 'pending'
--   auth_user_id + verified    → 'active'
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "portal_auth_user_id"  text,
  ADD COLUMN IF NOT EXISTS "portal_invited_at"    timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "portal_invited_by"    text;

CREATE INDEX IF NOT EXISTS "patients_portal_auth_user_idx"
  ON "resupply"."patients" ("portal_auth_user_id")
  WHERE "portal_auth_user_id" IS NOT NULL;
