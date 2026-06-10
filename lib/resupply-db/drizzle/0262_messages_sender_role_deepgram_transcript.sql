-- Widen messages.sender_role to admit the voice bridge's Deepgram
-- backup-transcript rows.
--
-- The voice WS handler persists the Deepgram-side transcript of every AI
-- voice call as ONE resupply.messages row tagged
-- sender_role='deepgram_transcript' (ws-handler.ts →
-- writeDeepgramAuditTranscript). Migration 0052 pinned sender_role to
-- ('patient','customer','admin','agent','system') BEFORE that writer
-- existed, so every transcript insert has been violating the CHECK and the
-- write — which is deliberately best-effort — only WARN-logged and dropped
-- the transcript. The clinician-review backup transcript was silently lost
-- on every Deepgram-enabled call.
--
-- All existing rows hold values inside the new (wider) set, so the re-add
-- validates clean with no backfill. Idempotent via DROP IF EXISTS + re-add.

ALTER TABLE "resupply"."messages"
  DROP CONSTRAINT IF EXISTS "messages_sender_role_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."messages"
  ADD CONSTRAINT "messages_sender_role_enum"
    CHECK (sender_role IN ('patient','customer','admin','agent','system','deepgram_transcript'));
