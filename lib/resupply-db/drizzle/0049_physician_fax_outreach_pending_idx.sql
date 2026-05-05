-- physician_fax_outreach pending-status partial index
-- (Phase G.16 follow-up — review feedback on PR #108).
--
-- The Phase G.16 ops-status feed runs `SELECT count(*) WHERE status='pending'`
-- on every /admin/operations refresh (60-second poll from the SPA).
-- The base table only has indexes on (patient_id, created_at) and
-- vendor_ref (the latter partial), neither of which helps a
-- status-keyed scan. As physician_fax_outreach grows, the count
-- query would degrade into a sequential scan.
--
-- A partial b-tree on `status` filtered to 'pending' is the
-- minimum-write-cost solution: we don't pay write amplification
-- for terminal-state rows ('sent', 'delivered', 'failed') that
-- we'll never count again. The index is small, fits in cache, and
-- the count becomes index-only.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE INDEX IF NOT EXISTS "physician_fax_outreach_pending_idx"
  ON "resupply"."physician_fax_outreach" ("status")
  WHERE "status" = 'pending';
