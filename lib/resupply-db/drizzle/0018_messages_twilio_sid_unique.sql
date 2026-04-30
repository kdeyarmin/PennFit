-- Replay-protection index: each inbound Twilio MessageSid must appear
-- at most once in the messages table.
--
-- Why a partial expression index:
--   `vendor_metadata` is JSONB and stores different envelope fields
--   per channel and direction. Only inbound SMS rows carry a
--   `twilio_message_sid` key; outbound rows never do. A partial index
--   (WHERE direction = 'inbound') avoids indexing the vastly larger
--   outbound set and keeps the index small and fast.
--
--   The expression `(vendor_metadata->>'twilio_message_sid')` extracts
--   the raw text value from the JSONB column. Postgres NULL-suppresses
--   rows where the key is absent, so outbound rows that lack the key
--   are excluded even without the WHERE clause — but the WHERE makes
--   the intent explicit and bounds the scan set.
--
-- Why NOT a regular column:
--   Adding a `twilio_message_sid` column would require a multi-step
--   migration (add nullable column, backfill, add constraint) and
--   would duplicate data already present in `vendor_metadata`. The
--   expression index gives the same uniqueness guarantee with zero
--   schema-shape change.
--
-- Operational impact:
--   CREATE INDEX CONCURRENTLY cannot run inside a transaction. We
--   accept a brief window (the index build) where the uniqueness
--   guarantee is enforced only by the application-layer pre-check in
--   /sms/inbound; after the build completes the DB enforces it too.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "messages_twilio_sid_inbound_uniq"
  ON "resupply"."messages" ((vendor_metadata->>'twilio_message_sid'))
  WHERE direction = 'inbound';
