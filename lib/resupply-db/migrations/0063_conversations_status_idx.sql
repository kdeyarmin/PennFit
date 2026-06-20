-- Migration 0063: Composite (status, last_message_at) index for the admin
-- inbox query (D-10).
--
-- The inbox list query filters on status IN ('open','awaiting_admin',
-- 'awaiting_patient') and orders by last_message_at DESC NULLS LAST.
-- The existing channelStatusIdx (channel, status) covers channel+status
-- filters but does not help the ORDER BY — the planner falls back to a
-- sequential scan + sort as conversation volume grows.
--
-- A composite (status, last_message_at) index lets the planner do an
-- index scan in reverse order of last_message_at for a given status set,
-- eliminating the sort step entirely.
--
-- The existing conversations_last_message_at_idx (single column) is left
-- in place — it still benefits the all-conversations timeline view that
-- omits the status filter.

CREATE INDEX "conversations_status_last_message_at_idx"
  ON "resupply"."conversations" ("status", "last_message_at" DESC NULLS LAST);
