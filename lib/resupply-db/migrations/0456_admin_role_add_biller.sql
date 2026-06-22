-- 0456_admin_role_add_biller — add the 'biller' granular admin role.
--
-- Why this exists
-- ---------------
-- Billing / revenue-cycle work (claims, eligibility, A/R, ERA posting,
-- clearinghouse ops) was previously done only by admin-tier staff. This
-- adds a dedicated `biller` granular role whose access is scoped to the
-- Billing area of the admin console, so a practice can hire a biller
-- without handing them the full admin surface.
--
-- What lands here
-- ---------------
--   * Adds 'biller' to the admin_users.role CHECK (it was last set to the
--     8-role set in 0188: admin, supervisor, csr, fitter, fulfillment,
--     compliance_officer, agent, rt). The coarse auth.users.role stays
--     'agent' (coarseAuthRoleFor maps every non-admin role to agent), so
--     the existing staff gate admits a biller without an auth_users
--     change. The `biller` role maps to a new `biller` effective bucket in
--     lib/resupply-auth/src/rbac.ts, which grants the new `billing.manage`
--     permission plus billing-context reads.
--
-- admin_users.role is governed by a CHECK constraint (admin_users_role_enum),
-- not a Postgres ENUM type, so we drop and re-add the wider check (same
-- shape as 0188). Additive + idempotent (DROP ... IF EXISTS) — it only
-- widens the allowed set and never rejects an existing row. Per ADR 003 —
-- versioned hand-authored migration; do NOT edit in place once shipped.

-- ---------------------------------------------------------------
-- Add 'biller' to the admin_users role enum (extends 0188's 8-role set).
-- ---------------------------------------------------------------
ALTER TABLE "resupply"."admin_users"
  DROP CONSTRAINT IF EXISTS "admin_users_role_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."admin_users"
  ADD CONSTRAINT "admin_users_role_enum"
  CHECK ("role" IN (
    'admin',
    'supervisor',
    'csr',
    'fitter',
    'fulfillment',
    'compliance_officer',
    'agent',
    'rt',
    'biller'
  ));
