-- 0328_org_id_fulfillment_shop — multi-tenant org_id backfill, batch 3
-- of N (fulfillment / shop). Phase 0, plan workstream A2.
--
-- See 0326 (batch 1) for the full rationale. Identical safe additive
-- shape: NULLABLE org_id + backfill to the seed tenant
-- (slug 'penn-home-medical') + FK + per-table index. No existing INSERT
-- breaks (nullable), nothing reads/filters org_id yet (no behavior
-- change). NOT NULL tightening + scoped-wrapper cutover land in this
-- domain's cutover PR.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── shop_orders ─────────────────────────────────────────────────────
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_orders"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_orders_org_idx"
  ON "resupply"."shop_orders" ("org_id");
--> statement-breakpoint

-- ── shop_order_items ────────────────────────────────────────────────
ALTER TABLE "resupply"."shop_order_items"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_order_items"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_items_org_idx"
  ON "resupply"."shop_order_items" ("org_id");
--> statement-breakpoint

-- ── shop_customers ──────────────────────────────────────────────────
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_customers"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customers_org_idx"
  ON "resupply"."shop_customers" ("org_id");
--> statement-breakpoint

-- ── inventory_reconciliations ───────────────────────────────────────
ALTER TABLE "resupply"."inventory_reconciliations"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."inventory_reconciliations"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reconciliations_org_idx"
  ON "resupply"."inventory_reconciliations" ("org_id");
