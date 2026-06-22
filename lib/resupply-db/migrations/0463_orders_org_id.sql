-- 0463_orders_org_id — make the legacy clinical-intake `public.orders` table
-- tenant-scoped.
--
-- `public.orders` (the mask-fitter / clinical-intake form submissions, created
-- in migration 0027) was never given an `org_id` during the multi-tenant
-- cutover (0332–0382). It holds patient PHI (name, email, phone, DOB, shipping
-- address) and is read by the admin order list/detail/analytics surfaces via
-- the `.raw()` escape hatch, so those reads discard the caller's tenant
-- context and span every tenant: the moment a second tenant places a fitter
-- order (the standalone `mask_fitter` plan is a live product), every tenant
-- admin can see every other tenant's patient orders. This adds the missing
-- `org_id` so the intake POST stamps the host tenant and every admin/worker
-- read filters to its own org.
--
-- Cross-schema FK: the table lives in `public`; organizations lives in
-- `resupply`. Postgres allows the cross-schema reference (same as the sibling
-- `public.reminder_subscriptions` fix in migration 0378).
--
-- order_reference stays GLOBALLY unique (it is a random `PENN-XXXXXX` code,
-- like reminder_subscriptions.manage_token) so existing track-by-reference
-- links keep working regardless of host.
--
-- Additive + idempotent: nullable column, seed backfill, indexed. A NULL
-- org_id on any pre-backfill row simply leaves it out of per-org filters until
-- set. We do NOT add a NOT NULL constraint here — every write path stamps
-- org_id, and leaving it nullable keeps the migration non-blocking on a
-- populated table (matches the 0378 reminder_subscriptions approach).

ALTER TABLE "public"."orders"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations" ("id");
--> statement-breakpoint

UPDATE "public"."orders"
SET "org_id" = (
  SELECT "id" FROM "resupply"."organizations"
  WHERE "slug" = 'penn-home-medical'
  LIMIT 1
)
WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "orders_org_idx"
  ON "public"."orders" ("org_id");
--> statement-breakpoint

-- Composite index for the admin order list, which filters by org_id and
-- orders by created_at DESC. Without it, every paginated list page sorts the
-- full tenant-filtered set.
CREATE INDEX IF NOT EXISTS "orders_org_created_at_idx"
  ON "public"."orders" ("org_id", "created_at" DESC);
