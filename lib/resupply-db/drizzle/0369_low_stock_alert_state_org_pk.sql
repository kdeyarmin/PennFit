-- 0369_low_stock_alert_state_org_pk — per-tenant low-stock alert state.
--
-- Re-keys resupply.low_stock_alert_state from a global (product_id) PRIMARY
-- KEY to a per-tenant (org_id, product_id) shape. Migration 0341 added the
-- org_id column (nullable, backfilled to the seed tenant) + an index, but
-- left the PRIMARY KEY as product_id alone.
--
-- WHY (the multi-tenant correctness bug this closes):
--   The low-stock cron now fans out across tenants and routes each catalog
--   read to that tenant's connected Stripe account (Stripe Connect). Stripe
--   product ids are only guaranteed unique WITHIN one account — two
--   connected accounts can hold the same product id. The cron's dedup upsert
--   used `onConflict: "product_id"`; with a product_id-only PK, tenant B's
--   upsert would CONFLICT WITH and OVERWRITE tenant A's row — including the
--   org-scoped org_id tag — corrupting cooldown/recovery state and silently
--   reassigning the row across tenants. Making (org_id, product_id) the key
--   lets each tenant hold its own state for the same product id, and the
--   cron's upsert switches to `onConflict: "org_id,product_id"` in lockstep.
--
-- Production preservation: 0341 already backfilled every existing row's
-- org_id to the seed tenant ('penn-home-medical'), so for the live
-- single-tenant deployment this is a pure constraint change — the effective
-- rows are unchanged. RLS + the org_isolation policy are already in place
-- (migration 0348's catalog loop covered this table once it carried org_id).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- Defensive re-backfill: re-anchor any stray NULL org_id to the seed org
-- before enforcing NOT NULL so the rekey can't fail on a null.
UPDATE "resupply"."low_stock_alert_state"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."low_stock_alert_state"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint

-- Swap the PRIMARY KEY from (product_id) to (org_id, product_id). Guarded so
-- a re-run (or a fresh DB where this already landed) is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'resupply'
      AND t.relname = 'low_stock_alert_state'
      AND c.contype = 'p'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      ) = ARRAY['org_id', 'product_id']
  ) THEN
    ALTER TABLE "resupply"."low_stock_alert_state"
      DROP CONSTRAINT IF EXISTS "low_stock_alert_state_pkey";
    ALTER TABLE "resupply"."low_stock_alert_state"
      ADD CONSTRAINT "low_stock_alert_state_pkey"
      PRIMARY KEY ("org_id", "product_id");
  END IF;
END $$;
