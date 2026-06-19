-- 0397_voice_calls_answered_by — capture Twilio's Answering Machine Detection
-- (AMD) result on the voice-call telemetry row.
--
-- The automated resupply reminder call (reminders.place-call) now enables
-- Twilio machine detection so a voicemail pickup is distinguishable from a
-- live human answer. Twilio reports the verdict as `AnsweredBy` on the
-- status callback (human | machine_start | machine_end_* | fax | unknown);
-- we persist it here so the escalation ladder can tell a CONNECTED call
-- (reached a person) from a NO-CONNECT (no-answer / busy / failed / voicemail)
-- and decide whether to retry the call (up to the attempt cap) or hand off to
-- a CSR.
--
-- Nullable + no default: pre-AMD rows and calls placed without detection
-- simply leave it NULL, and the escalation treats a completed call with a
-- NULL verdict as connected (the safe default — we reached the line).
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."voice_calls"
  ADD COLUMN IF NOT EXISTS "answered_by" text;
