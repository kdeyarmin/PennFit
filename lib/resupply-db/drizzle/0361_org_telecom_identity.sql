-- 0361_org_telecom_identity — per-tenant Twilio sending identity (G7).
--
-- Phase 2 relaxes the single-Twilio-identity invariant: today every SMS
-- and call goes out from the one platform `TWILIO_PHONE_NUMBER` /
-- `TWILIO_MESSAGING_SERVICE_SID`. For SaaS, each DME tenant sends from
-- THEIR OWN number, and inbound SMS/voice/MMS webhooks must route to the
-- tenant the called number belongs to.
--
--   * sms_from_number          — the tenant's outbound SMS / MMS sender
--     (E.164). NULL → platform default, unchanged.
--   * voice_from_number        — the tenant's outbound caller-id (E.164).
--     NULL → platform default.
--   * twilio_messaging_service_sid — optional Messaging Service SID
--     (`MG…`) used in place of a bare from-number for SMS routing /
--     sender pools. NULL → platform default.
--
-- ADDITIVE and inert by default: all three columns are nullable with no
-- default, and the seed tenant (Penn Home Medical Supply) leaves them NULL
-- so its messaging continues on the platform number. A tenant only sends
-- under its own identity once an operator provisions the number in Twilio
-- AND populates these columns — an external, per-tenant setup step that is
-- NOT enforced here (the resolver fails soft to the platform default).
--
-- The unique partial indexes support the inbound webhook's reverse lookup
-- (resolve `org_id` from the called `To` number), excluding the common
-- NULL rows. A given number routes to exactly one tenant.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

ALTER TABLE "resupply"."organizations"
  ADD COLUMN IF NOT EXISTS "sms_from_number" text,
  ADD COLUMN IF NOT EXISTS "voice_from_number" text,
  ADD COLUMN IF NOT EXISTS "twilio_messaging_service_sid" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_sms_from_number_key"
  ON "resupply"."organizations" ("sms_from_number")
  WHERE "sms_from_number" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_voice_from_number_key"
  ON "resupply"."organizations" ("voice_from_number")
  WHERE "voice_from_number" IS NOT NULL;
