-- 0355_platform_admins — the platform super-admin tier (G4).
--
-- Until now the highest role was a TENANT admin: `requireAdmin` admits a
-- staff `auth.users` row and binds every request to exactly one
-- `org_id` (the admin's tenant). There was no role ABOVE a tenant — no
-- way to operate the platform itself (list/suspend tenants, see
-- cross-tenant usage, onboard a new DME from a console).
--
-- This adds that tier as a small, ADDITIVE table rather than a new
-- `auth.users.role` enum value, so it touches none of the existing
-- tenant-auth logic (`requireAdmin` / RBAC). A platform admin is simply
-- an `auth.users` row whose id also appears here. The new
-- `requirePlatformAdmin` gate resolves the session exactly like
-- `requireAdmin`, then checks membership in this table.
--
-- NOT tenant-scoped: a platform admin is above all tenants, so this table
-- intentionally has NO `org_id` column (and is read via the global
-- `.raw()` escape hatch, like `organizations` and the other directories).
--
-- Seeding: the existing seed-org super-admins (Penn Home Medical Supply's
-- owners — `admin_users.role = 'admin'`, which maps to `super_admin`) ARE
-- the platform operator during the single-tenant → multi-tenant
-- transition, so we grant them platform-admin here. Idempotent; a fresh
-- environment with no such rows simply seeds nothing and an operator
-- grants the first platform admin out of band.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

CREATE TABLE IF NOT EXISTS "resupply"."platform_admins" (
  -- The `auth.users.id` (resupply_auth schema) of the platform admin.
  -- No cross-schema FK (same convention as admin_users.auth_user_id).
  "auth_user_id" text PRIMARY KEY,
  -- Free-form: who granted it (an email or a "migration:NNNN" marker).
  -- Free-form text survives a deleted granter row, matching the
  -- app_config / feature_flags updated_by_* convention.
  "granted_by_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; same posture as the rest of
-- the resupply schema — see migration 0170).
ALTER TABLE "resupply"."platform_admins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Grant the seed tenant's active super-admins platform-admin. They are
-- the operator of the platform during the transition. `admin_users.role
-- = 'admin'` is the super_admin (db role; see lib/resupply-auth/rbac.ts).
INSERT INTO "resupply"."platform_admins" ("auth_user_id", "granted_by_email")
SELECT au."auth_user_id", 'migration:0355'
FROM "resupply"."admin_users" au
JOIN "resupply"."organizations" o ON o."id" = au."org_id"
WHERE o."slug" = 'penn-home-medical'
  AND au."role" = 'admin'
  AND au."status" = 'active'
  AND au."auth_user_id" IS NOT NULL
ON CONFLICT ("auth_user_id") DO NOTHING;
