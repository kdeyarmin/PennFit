-- Org-scope the equipment_assets serial-number unique index.
--
-- 0078 created equipment_assets_manufacturer_serial_unique as
--   UNIQUE (manufacturer, serial_number)
-- keyed only on the (tenant-agnostic) device manufacturer + serial. 0341 later
-- added org_id to the table (backfilled to the seed org) but never re-scoped
-- this index — the same miss 0476 / 0478 fixed for other tables.
--
-- The therapy-cloud auto-link helper (lib/integrations/link-equipment.ts)
-- looks up an existing asset through the ORG-SCOPED client (filtered to the
-- caller's org_id), and on a miss INSERTs a new row (org_id forced to the
-- caller). But the INSERT is still governed by this GLOBAL unique index, so
-- when tenant B syncs a patient whose device serial S (manufacturer M) already
-- exists as a row owned by tenant A:
--   * B's org-scoped lookup finds NO row (it's A's), so the code proceeds,
--   * the INSERT trips the global (M, S) unique index with 23505,
--   * the 23505 recovery re-lookup is ALSO org-scoped, finds nothing, and
--     re-throws — surfacing a 500 on tenant B's equipment-sync for a collision
--     caused entirely by tenant A's data, and letting B infer A holds serial S.
-- Re-scope the uniqueness per-tenant so each tenant's serial namespace is
-- independent and the org-scoped lookup/insert pair is internally consistent.
--
-- Safe to apply: the OLD index is STRICTLY stronger (global-unique on
-- (manufacturer, serial_number)) than the new per-tenant one, so all existing
-- rows already satisfy the new (org_id, manufacturer, serial_number)
-- uniqueness — there are no cross-tenant duplicate serials today and the CREATE
-- cannot fail on current data. org_id is populated (0341 backfill). Idempotent:
-- DROP IF EXISTS + CREATE … IF NOT EXISTS. Plain (non-CONCURRENTLY) so it runs
-- inside the migrator's transaction.

DROP INDEX IF EXISTS "resupply"."equipment_assets_manufacturer_serial_unique";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "equipment_assets_org_manufacturer_serial_unique"
  ON "resupply"."equipment_assets" ("org_id", "manufacturer", "serial_number");
