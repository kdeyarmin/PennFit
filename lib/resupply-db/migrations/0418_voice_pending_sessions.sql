-- 0418 — shared, durable store for the voice Media Stream handoff.
--
-- Background:
--   The pending-session handoff between a voice webhook (inbound reorder /
--   inbound sales / outbound check-in / diagnostic) and Twilio's Media
--   Stream WebSocket upgrade was an in-memory Map inside the resupply-api
--   process (lib/voice/pending-sessions.ts). That only holds under a SINGLE
--   instance: the webhook registers the session in one replica's memory,
--   but Twilio's follow-up WebSocket is load-balanced to a (possibly)
--   different replica, which has no record of the conversationId and rejects
--   the upgrade with HTTP 401 "no-pending-session". Twilio surfaces that as
--   error 31920 (Stream WebSocket handshake error) and the call dies the
--   instant it connects (duration 0). Once production scaled past one
--   replica, every voice flow — including the CareMetric Breathe platform
--   sales line — became intermittently unreachable (the caller's carrier
--   reports the line as busy).
--
-- Fix:
--   Move the handoff to this table so ANY replica can claim a session that
--   ANY replica registered. Rows are short-lived (default 5-minute TTL):
--     register → upsert
--     peek     → select where not expired (outbound twiml-connect)
--     claim    → delete ... returning where not expired (atomic single
--                statement, so a leaked conversationId rides exactly one
--                WS upgrade)
--   Expired rows are swept opportunistically on register.
--
--   `payload` holds the full PendingSessionEntry as JSON. No patient
--   identifier ever rides the WS URL — only the opaque conversationId — and
--   the row is deleted seconds later on claim. patient_id / episode_id /
--   org_id inside the payload are internal uuids, not clinical content.
--
-- Journal posture (per CLAUDE.md): NOT added to meta/_journal.json;
-- migrate.mjs dedups by file hash and runs each SQL once. Additive +
-- IF NOT EXISTS, so a re-run / forward-deploy is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."voice_pending_sessions" (
  "conversation_id" text PRIMARY KEY,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint

-- The opportunistic "delete where expires_at < now()" sweep on register
-- and the not-expired filter on peek/claim both read expires_at; keep them
-- cheap. The live set is tiny (only in-flight calls), so the index stays
-- small.
CREATE INDEX IF NOT EXISTS "voice_pending_sessions_expires_at_idx"
  ON "resupply"."voice_pending_sessions" ("expires_at");
