-- Add a transient 'sending' status to recall_notifications so the send
-- sweep can CLAIM a row (queued -> sending) BEFORE the vendor call,
-- making the send exclusive across processes.
--
-- Before this, the sweep sent first and flipped status afterward, so two
-- horizontally-scaled worker instances could both pull the same 'queued'
-- row from the SELECT and double-send a recall notice to a patient. The
-- in-process single-flight guard added earlier closes the same-process
-- race but cannot cover cross-process. With 'sending' the worker now:
--   0. re-queues stale 'sending' rows (a crashed worker's orphans),
--   1. flips queued -> sending (only one claimant wins the UPDATE),
--   2. sends, then flips sending -> sent/failed/skipped.
--
-- Idempotent + from-scratch safe: drop the existing CHECK and re-add it
-- with the extra value under the same constraint name, so the on-DB
-- object is replaced in place against the 0092 baseline. migrate.mjs
-- dedups by file hash, so this runs exactly once per database.

ALTER TABLE "resupply"."recall_notifications"
  DROP CONSTRAINT IF EXISTS "recall_notifications_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."recall_notifications"
  ADD CONSTRAINT "recall_notifications_status_enum"
  CHECK ("status" IN ('queued', 'sending', 'sent', 'failed', 'bounced', 'skipped'));
