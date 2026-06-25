-- Org-scope the back-in-stock pending-signup unique index.
--
-- 0031 created shop_bis_unique_pending_idx as UNIQUE (product_id, email)
-- WHERE notified_at IS NULL — keyed only on the (tenant-agnostic) Stripe
-- product id + email. 0342 later added org_id to the table but never
-- re-scoped this index. The public signup route now host-resolves the tenant
-- and writes the row under that tenant's org_id, and the recorder treats a
-- 23505 unique-violation as a clean "already on the list" duplicate. So if
-- two tenants sell the SAME Stripe product and the SAME email signs up for
-- both before notification, the second tenant's INSERT trips the GLOBAL unique
-- index, is swallowed as a duplicate, and NO row is created under the second
-- tenant's org_id — that tenant's restock dispatch (which filters by
-- product_id AND org_id) then never emails the customer. Re-scope the
-- uniqueness per-tenant so each tenant gets its own pending-signup row.
--
-- Also re-key the pending lookup index to lead with org_id, since the dispatch
-- query is always org-scoped (getOrgScopedClient adds .eq("org_id", …)).
--
-- Safe to apply: the OLD unique index is STRICTLY stronger (global-unique on
-- (product_id, email)) than the new per-tenant one, so all existing pending
-- rows already satisfy the new (org_id, product_id, email) uniqueness — the
-- CREATE cannot fail on current data. org_id is populated (0342). Idempotent:
-- DROP IF EXISTS + CREATE … IF NOT EXISTS. Plain (non-CONCURRENTLY) so it runs
-- inside the migrator's transaction.

DROP INDEX IF EXISTS "resupply"."shop_bis_unique_pending_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "shop_bis_unique_pending_org_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("org_id", "product_id", "email")
  WHERE "notified_at" IS NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "resupply"."shop_bis_pending_idx";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "shop_bis_pending_org_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("org_id", "product_id")
  WHERE "notified_at" IS NULL;
