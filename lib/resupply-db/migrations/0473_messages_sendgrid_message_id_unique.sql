-- Replay-protection index for inbound email (SendGrid Inbound Parse).
--
-- SendGrid Inbound Parse carries NO vendor signature — HTTP basic auth is the
-- only gate, so a captured (authenticated) POST can be replayed verbatim. Each
-- inbound email's Message-ID must therefore appear at most once in the messages
-- table, mirroring the inbound Twilio MessageSid guard in
-- 0028_messages_twilio_sid_unique.sql.
--
-- Why a partial expression index:
--   `vendor_metadata` is JSONB; only inbound SendGrid rows carry a
--   `sendgrid_message_id` key. The expression
--   `(vendor_metadata->>'sendgrid_message_id')` extracts the raw text; Postgres
--   allows multiple NULLs in a unique index, so inbound rows that lack a
--   Message-ID (the key is absent → NULL) never conflict with each other. The
--   `WHERE direction = 'inbound'` keeps the index small and the intent explicit.
--
-- The application-layer pre-check in /email/inbound-parse returns a clean 200
-- on a duplicate Message-ID; this index enforces the same uniqueness at the
-- storage layer (defense in depth) and is the backstop for the pre-check's
-- read-then-insert race.
--
-- CONCURRENTLY is intentionally omitted (the migrator wraps each file in a
-- transaction; same rationale as 0028). Idempotent via IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS "messages_sendgrid_message_id_inbound_uniq"
  ON "resupply"."messages" ((vendor_metadata->>'sendgrid_message_id'))
  WHERE direction = 'inbound';
