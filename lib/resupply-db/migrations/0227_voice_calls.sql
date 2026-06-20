-- 0227_voice_calls — per-call timing ledger for voice metrics.
--
-- Voice call lifecycle currently flows only through logAudit(), which is
-- a no-op stub (compliance machinery was retired), so there was no
-- queryable source for call-volume / answer-rate / handle-time metrics.
-- This table is that source: one row per Twilio CallSid, populated
-- best-effort from POST /voice/status-callback as the call transitions
-- (initiated -> ringing -> in-progress -> completed). It is purely
-- operational telemetry.
--
-- PHI posture: this table holds NO patient identifiers. From/To phone
-- numbers are deliberately NOT stored (the status-callback handler
-- already refuses to read them). Only structural timing + the Twilio
-- CallSid + the conversation FK live here.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."voice_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "call_sid" varchar(64) NOT NULL,
  "conversation_id" uuid
    REFERENCES "resupply"."conversations"("id") ON DELETE SET NULL,
  "direction" varchar(32),
  "status" text,
  "initiated_at" timestamp with time zone,
  "answered_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "duration_seconds" integer,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "voice_calls_call_sid_unique" UNIQUE ("call_sid"),
  CONSTRAINT "voice_calls_duration_non_negative"
    CHECK ("duration_seconds" IS NULL OR "duration_seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_calls_created_at_idx"
  ON "resupply"."voice_calls" ("created_at");
