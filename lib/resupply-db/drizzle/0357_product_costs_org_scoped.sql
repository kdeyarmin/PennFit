-- 0357_product_costs_org_scoped — multi-tenant: scope product_costs per tenant.
--
-- WHY
--   resupply.product_costs (mig 0193) holds the CURRENT unit cost (COGS)
--   per shop SKU, keyed one-row-per-SKU. It was left global by the 0331-0342
--   org_id backfill batches, which classified it with the reference catalogs
--   (hcpcs_codes, denial_codes, …). But COGS is NOT reference data: it is
--   operator-entered tenant business data — each DME negotiates its own
--   supplier pricing and edits it from /admin (admin.product_costs). A shared
--   table computes every tenant's gross-margin / claim-line COGS snapshot
--   from another tenant's costs, and one tenant's admin upsert silently
--   rewrites another tenant's margins. So it must be per tenant.
--
-- WHAT
--   * Add org_id (NULLABLE first), backfill existing rows to the seed tenant
--     (penn-home-medical), then SET NOT NULL — the standard additive shape.
--   * Re-key from PRIMARY KEY (sku) to PRIMARY KEY (org_id, sku): the cost
--     is now unique PER TENANT per SKU, and the composite PK's leading
--     org_id also serves every org-scoped read (admin list, the COGS
--     lookup's `.eq(org_id).in(sku)`), so no extra index is needed.
--   * Add the `org_isolation` RLS policy (mirrors 0348) — runtime-inert
--     today (service_role bypasses RLS), the backstop for the day access
--     moves to a non-bypassing role.
--
-- The runtime cutover (the COGS lookup + admin CRUD move from the unscoped
-- `.raw()` read to the org-scoped facade) ships in the same PR. Single-
-- tenant behavior is unchanged: all callers resolve the seed org today, so
-- they read/write exactly the rows they did before.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."product_costs"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."product_costs"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."product_costs"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
-- Re-key: one cost per SKU PER TENANT. Reuse the conventional pkey name.
ALTER TABLE "resupply"."product_costs"
  DROP CONSTRAINT IF EXISTS "product_costs_pkey";
--> statement-breakpoint
ALTER TABLE "resupply"."product_costs"
  ADD CONSTRAINT "product_costs_pkey" PRIMARY KEY ("org_id", "sku");
--> statement-breakpoint
-- Defense-in-depth RLS (mirrors 0348). product_costs already has RLS
-- ENABLED (0170); this adds the per-tenant policy keyed on the
-- app.current_org_id GUC. service_role (the runtime path) bypasses it.
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."product_costs";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."product_costs"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
