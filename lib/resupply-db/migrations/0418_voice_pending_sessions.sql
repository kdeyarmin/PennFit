-- 0418 — shared, durable store for the voice Media Stream handoff.
--
-- Background:
--   The pending-session handoff between a voice webhook (inbound reorder /
--   inbound sales / outbound check-in / diagnostic) and Twilio's Media
--   Stream WebSocket upgrade was an in-memory Map inside the resupply-api
--   process (lib/voice/pending-sessions.ts). In-memory state does NOT survive
--   the process being replaced or restarted: when a deploy rolls the (single)
--   replica — or the process restarts/crashes — in the ~1s gap between the
--   webhook POST and Twilio's follow-up WebSocket, the fresh process has an
--   empty map, so the WS upgrade is rejected with HTTP 401
--   "no-pending-session". Twilio surfaces that as error 31920 (Stream
--   WebSocket handshake error) and the call dies the instant it connects
--   (duration 0) — surfacing to callers as a carrier "line is busy". The
--   failures cluster around deploys (verified: the handoff works fine in
--   steady state). The same in-memory state also would not survive horizontal
--   scaling to more than one replica.
--
-- Fix:
--   Move the handoff to this table so it survives a process restart/redeploy
--   (and any future multi-replica scaling) — any process can claim a session
--   any process registered. Rows are short-lived (default 5-minute TTL):
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
--> statement-breakpoint

-- Deny-all by default (service-role bypasses; resupply-schema posture,
-- migration 0170). The schema is exposed via PostgREST and the payload can
-- carry patient/episode/org ids for in-flight calls, so keep the baseline
-- RLS lock-down every other resupply table has — no tenant predicate needed
-- (only the service role touches this ephemeral handoff table).
ALTER TABLE "resupply"."voice_pending_sessions" ENABLE ROW LEVEL SECURITY;
