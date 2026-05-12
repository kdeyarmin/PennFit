-- Granular RBAC Phase A — extend admin_users.role beyond admin/agent.
-- See lib/resupply-db/src/schema/admin-users.ts for the role catalog
-- rationale and lib/resupply-auth/src/rbac.ts for the role→permission
-- map (lives in code, not DB).
--
-- Migration shape: Postgres CHECK constraints aren't ALTERable in
-- place — drop the old one and add the wider one. We do this in a
-- single transaction so a partial failure can't leave the table
-- with no role check at all.
--
-- IMPORTANT — journal posture: not yet listed in _journal.json,
-- matching the established pattern for migrations 0050+.

BEGIN;

ALTER TABLE "resupply"."admin_users"
  DROP CONSTRAINT IF EXISTS "admin_users_role_enum";

ALTER TABLE "resupply"."admin_users"
  ADD CONSTRAINT "admin_users_role_enum"
  CHECK ("role" IN (
    'admin',
    'supervisor',
    'csr',
    'fitter',
    'fulfillment',
    'compliance_officer',
    'agent'
  ));

COMMIT;
