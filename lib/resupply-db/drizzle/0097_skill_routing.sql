-- Skill-based conversation routing (Tier 1 J #4):
--   * admin_users.skills jsonb[] — curated tags per admin
--   * conversations.required_skills jsonb[] — tags the convo needs
--
-- See lib/resupply-db/src/schema/admin-users.ts and
-- conversations.ts for the column rationale.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "skills" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "required_skills" jsonb NOT NULL DEFAULT '[]'::jsonb;
