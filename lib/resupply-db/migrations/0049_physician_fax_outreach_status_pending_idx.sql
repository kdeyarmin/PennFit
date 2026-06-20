-- physician_fax_outreach — partial index on status for the
-- ops-status pending-queue counter (Phase G.16).
--
-- The ops-status endpoint polls GET /admin/ops-status on a short
-- interval and runs:
--
--   SELECT count(*)::int FROM resupply.physician_fax_outreach
--   WHERE status = 'pending';
--
-- Without an index Postgres falls back to a sequential scan, which
-- is fine while the table is small but degrades as rows accumulate
-- over time. A *partial* index (WHERE status = 'pending') is the
-- right choice here for two reasons:
--
--   1. The pending set is the minority at steady state — most rows
--      have moved on to 'sent', 'delivered', or 'failed' and don't
--      need to be in the index at all. The partial index stays small
--      no matter how large the overall table grows.
--
--   2. The count is always against exactly this predicate, so
--      Postgres can satisfy it with a fast Index Only Scan on the
--      partial index rather than visiting the heap.
--
-- A full index on (status) would work but wastes space on the
-- 'sent'/'delivered'/'failed' majority. A partial index on
-- status = 'pending' is cheaper to write/maintain and lets
-- Postgres answer the count without touching the heap.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE INDEX IF NOT EXISTS "physician_fax_outreach_status_pending_idx"
  ON "resupply"."physician_fax_outreach" ("status")
  WHERE "status" = 'pending';
