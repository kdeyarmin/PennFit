-- 0034_conversations_customer_last_read_at — track the last time the
-- shop customer viewed their in-app conversation, so the storefront
-- can show an "X new replies from PennPaps" badge in the header.
--
-- Why on `conversations` (vs. a separate join table):
--   The single-thread-per-customer policy from PR #53 means there
--   is at most one in-app conversation row per customer. A column
--   on `conversations` is a one-to-one mirror of the per-customer
--   "last read" cursor and avoids a second table for v1.
--   If we ever support multi-thread per customer (per-topic
--   threads, archive history) we'll keep this column for the
--   active thread and add a new join table for the archive — the
--   migration is a column rename, not a teardown.
--
-- Semantics:
--   `customer_last_read_at = NULL` → customer has never opened the
--   thread; every outbound CSR message counts as "unread".
--   `customer_last_read_at >= max(messages.created_at WHERE direction='outbound')`
--   → all CSR replies seen.
--
-- The column is nullable to match the implicit "never read" state
-- on existing rows (if we backfilled a value the badge would mis-
-- count immediately).
--
-- Patient-flow rows (channel != 'in_app') leave this null forever;
-- the column is harmless on those rows.

ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "customer_last_read_at" timestamp with time zone;
