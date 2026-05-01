-- 0023_drop_admin_users_clerk_columns — final removal of legacy
-- Clerk linkage columns from `resupply.admin_users`.
--
-- Stage 5d.2 of the Clerk → in-house migration. After Stage 5b
-- the team-management code stopped reading or writing
-- `clerk_user_id` / `clerk_invitation_id`; the values are no
-- longer trusted for any decision. Stage 5d.1 dropped the
-- back-compat shims in TypeScript. Stage 5d.2 (this migration)
-- closes the loop in the database.
--
-- Dropping `clerk_user_id` also drops the auto-generated UNIQUE
-- index that backed it. The replacement uniqueness constraint —
-- one row per `auth_user_id` — is enforced at the application
-- level (the team-invite helper checks for an existing row before
-- insert) and by the existing `email_lower` UNIQUE constraint.
-- A future migration may add a partial UNIQUE on
-- `(auth_user_id) WHERE auth_user_id IS NOT NULL` if we ever
-- hit a need for it; today the email constraint is enough.
--
-- Reversibility: this migration is destructive. To roll back,
-- restore from the pre-migration backup and re-apply earlier
-- migrations through 0022.

ALTER TABLE "resupply"."admin_users" DROP COLUMN IF EXISTS "clerk_user_id";
ALTER TABLE "resupply"."admin_users" DROP COLUMN IF EXISTS "clerk_invitation_id";
