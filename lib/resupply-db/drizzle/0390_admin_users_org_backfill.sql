-- 0390_admin_users_org_backfill — materialize an admin_users row for every
-- active auth admin so requireAdmin resolves a real tenant for them rather
-- than the seed-org fallback.
--
-- requireAdmin resolves the caller's tenant from resupply.admin_users.org_id
-- (keyed by auth_user_id). That column is NOT NULL (0336 + the 0341
-- completion), so an admin_users ROW always carries a real tenant — the
-- fail-closed binding is already enforced by the constraint. The one soft
-- spot is an active auth admin (resupply_auth.users.role IN ('admin','agent'),
-- status='active') with NO admin_users row — the legacy "pre-Phase-A" /
-- bootstrap account — for whom requireAdmin falls back to the seed org.
--
-- Materialize (or, if a row already exists by email, just LINK its
-- auth_user_id) a row for each, bound to the seed org, so real admins are
-- explicitly tenant-bound and the seed fallback is reserved for genuine
-- seed/platform admins. The conflict branch NEVER touches role/status, so a
-- deliberately downgraded admin (admin→csr in admin_users) keeps their
-- reduced role; org_id is already non-null on any existing row, so it is not
-- rewritten.
--
-- Idempotent: a no-op on a fresh replay (no users) and on re-run. Guarded on
-- the seed org existing so a malformed environment can't insert a NULL org_id.

INSERT INTO "resupply"."admin_users" AS au
  ("email_lower", "role", "status", "auth_user_id", "org_id", "accepted_at")
SELECT
  u."email_lower",
  u."role",
  'active',
  u."id",
  (SELECT "id" FROM "resupply"."organizations"
   WHERE "slug" = 'penn-home-medical' LIMIT 1),
  now()
FROM "resupply_auth"."users" u
WHERE u."role" IN ('admin', 'agent')
  AND u."status" = 'active'
  AND EXISTS (SELECT 1 FROM "resupply"."organizations"
              WHERE "slug" = 'penn-home-medical')
ON CONFLICT ("email_lower") DO UPDATE SET
  -- Link the auth user only when missing; never overwrite an existing
  -- role/status (preserves a deliberate downgrade). org_id is already
  -- non-null on the existing row, so it stays as-is.
  "auth_user_id" = COALESCE(au."auth_user_id", EXCLUDED."auth_user_id"),
  "updated_at"   = now();
