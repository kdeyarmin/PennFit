-- 0477_admin_audit_log_org_id — make the legacy `public.admin_audit_log`
-- table tenant-scoped.
--
-- `public.admin_audit_log` (created in 0027 alongside `public.orders` and
-- `public.reminder_subscriptions`) records admin actions on the storefront
-- order surfaces: admin_email, admin_user_id, action (which embeds order
-- references and list-filter search terms like `list_orders:q=<name>`),
-- target_order_id, and the admin's IP. Its siblings were tenant-scoped during
-- the multi-tenant cutover (orders in 0463, reminder_subscriptions in 0378)
-- but this table was missed: GET /admin/audit-log reads it via the `.raw()`
-- escape hatch with NO org_id filter, so any signed-in tenant admin sees
-- EVERY other tenant's admin-action rows. Add the missing org_id so each
-- write stamps the caller's tenant and the read filters to its own org.
--
-- Cross-schema FK: the table lives in `public`; organizations lives in
-- `resupply`. Postgres allows the reference (same as orders/reminder_subs).
--
-- Additive + idempotent: nullable column, seed backfill, indexed. We do NOT
-- add NOT NULL — every write path stamps org_id, and leaving it nullable keeps
-- the migration non-blocking on a populated table (matches 0463/0378).

ALTER TABLE "public"."admin_audit_log"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations" ("id");
--> statement-breakpoint

UPDATE "public"."admin_audit_log"
SET "org_id" = (
  SELECT "id" FROM "resupply"."organizations"
  WHERE "slug" = 'penn-home-medical'
  LIMIT 1
)
WHERE "org_id" IS NULL;
--> statement-breakpoint

-- Composite index for GET /admin/audit-log, which filters by org_id and
-- orders by occurred_at DESC.
CREATE INDEX IF NOT EXISTS "admin_audit_log_org_occurred_at_idx"
  ON "public"."admin_audit_log" ("org_id", "occurred_at" DESC);
