-- 0383_platform_admin_kdeyarmin — make kdeyarmin@comcast.net the platform
-- super-admin explicitly.
--
-- The platform super-admin tier is membership in
-- `resupply.platform_admins` (migration 0355). 0355 seeded the seed
-- tenant's active super-admins as the platform operator during the
-- single-tenant → multi-tenant transition — which already covers this
-- account today. This migration makes the grant EXPLICIT and durable so
-- it no longer rides on that seed-tenant coincidence: it grants
-- platform-admin to whichever `resupply_auth.users` row owns this email,
-- regardless of tenant.
--
-- The grant is by EMAIL, not a hardcoded id, so it works in any
-- environment that has bootstrapped this admin account. If no such auth
-- user exists yet (a brand-new environment), the SELECT matches nothing
-- and the migration is a clean no-op — bootstrap the account first with
-- `pnpm --filter @workspace/scripts auth:bootstrap-admin`, then this
-- grant applies on the next deploy.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

INSERT INTO "resupply"."platform_admins" ("auth_user_id", "granted_by_email")
SELECT u."id", 'migration:0383'
FROM "resupply_auth"."users" u
WHERE u."email_lower" = 'kdeyarmin@comcast.net'
ON CONFLICT ("auth_user_id") DO NOTHING;
