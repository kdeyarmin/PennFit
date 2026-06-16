-- 0364_org_telecom_identity — per-tenant Twilio sending identity (G7).
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

-- Per-column uniqueness. The predicate excludes both NULL and blank
-- (whitespace-only) values so an accidental '' can't claim the single
-- globally-unique empty slot — matching the resolver, which treats blank
-- as "unset". (The trigger below also normalizes blank -> NULL on write.)
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_sms_from_number_key"
  ON "resupply"."organizations" ("sms_from_number")
  WHERE "sms_from_number" IS NOT NULL AND btrim("sms_from_number") <> '';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_voice_from_number_key"
  ON "resupply"."organizations" ("voice_from_number")
  WHERE "voice_from_number" IS NOT NULL AND btrim("voice_from_number") <> '';
--> statement-breakpoint

-- CROSS-COLUMN routing invariant: one called number → exactly ONE tenant.
-- The two per-column indexes alone don't stop org A using number X for SMS
-- while org B uses the SAME X for voice — both would pass, but
-- `resolveOrgIdByCalledNumber()` matches either column and `limit(1)`,
-- so an inbound webhook to X could be assigned to an arbitrary tenant.
-- This trigger (a) normalizes blank -> NULL so "unset" never indexes, and
-- (b) rejects a write whose sms/voice number already belongs to ANOTHER
-- org in EITHER column. A tenant may reuse the same number for its own
-- SMS and voice (same row is excluded); only cross-ORG collisions fail.
CREATE OR REPLACE FUNCTION "resupply"."organizations_telecom_number_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sms_from_number" IS NOT NULL AND btrim(NEW."sms_from_number") = '' THEN
    NEW."sms_from_number" := NULL;
  END IF;
  IF NEW."voice_from_number" IS NOT NULL AND btrim(NEW."voice_from_number") = '' THEN
    NEW."voice_from_number" := NULL;
  END IF;

  IF NEW."sms_from_number" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "resupply"."organizations" o
    WHERE o."id" <> NEW."id"
      AND NEW."sms_from_number" IN (o."sms_from_number", o."voice_from_number")
  ) THEN
    RAISE EXCEPTION 'telecom number % is already assigned to another tenant',
      NEW."sms_from_number" USING ERRCODE = 'unique_violation';
  END IF;

  IF NEW."voice_from_number" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "resupply"."organizations" o
    WHERE o."id" <> NEW."id"
      AND NEW."voice_from_number" IN (o."sms_from_number", o."voice_from_number")
  ) THEN
    RAISE EXCEPTION 'telecom number % is already assigned to another tenant',
      NEW."voice_from_number" USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "organizations_telecom_number_guard"
  ON "resupply"."organizations";
--> statement-breakpoint

CREATE TRIGGER "organizations_telecom_number_guard"
  BEFORE INSERT OR UPDATE OF "sms_from_number", "voice_from_number"
  ON "resupply"."organizations"
  FOR EACH ROW
  EXECUTE FUNCTION "resupply"."organizations_telecom_number_guard"();
