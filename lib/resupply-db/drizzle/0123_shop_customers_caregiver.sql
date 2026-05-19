-- 0123_shop_customers_caregiver — designated authorized contact for a
-- shop customer.
--
-- Why
-- ---
-- The CPAP demographic skews older and has heavy caregiver involvement.
-- An adult child or spouse often manages reorders, tracks shipments,
-- and answers billing questions on behalf of the patient. Today every
-- transactional email + push notification goes ONLY to the patient,
-- which leaves the caregiver out of the loop on the very communications
-- they're being asked to act on.
--
-- This migration adds a small "designated authorized contact" surface
-- to shop_customers — the patient consents (in writing, via the UI)
-- to share resupply-related communications with one named contact.
-- The downstream dispatchers (shipping notification, post-delivery
-- follow-up) send a SEPARATE email to the caregiver with copy that
-- correctly addresses them as the caregiver — not a BCC of the
-- patient's email, which would muddle the audit story.
--
-- HIPAA / consent model
-- ---------------------
-- We treat the caregiver as a Designated Authorized Representative
-- for "supplies-status communications only" — a narrow scope that
-- does NOT extend to claims / EOB / billing detail unless the patient
-- ALSO opts in to those (a future column; the current model defaults
-- caregiver visibility to operational shipment status only).
--
--   caregiver_consent_at  — timestamp the patient affirmed the
--                           relationship. Null = no caregiver on
--                           file. Non-null = active until revoked.
--   caregiver_revoked_at  — timestamp the patient withdrew consent.
--                           Once stamped, the row is treated as
--                           inactive; future opt-ins re-stamp the
--                           consent_at and clear revoked_at.
--
-- Identification fields:
--   caregiver_email       — single email address. We don't validate
--                           ownership; the patient affirms the
--                           identity matches the consent at UI time.
--   caregiver_name        — friendly display name for the email
--                           greeting ("Hi Anna,").
--
-- A future iteration can add caregiver_phone for SMS, claim-scope
-- consent flags, and multiple caregivers; the current schema is the
-- 80%-of-the-value minimum.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_email" text;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_name" text;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_consent_at"
    timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_revoked_at"
    timestamp with time zone;
--> statement-breakpoint

-- Integrity: revoked_at requires consent_at (you can't revoke what
-- you never granted). Email + name must be present together when
-- consent_at is set — a half-filled caregiver row is meaningless.
ALTER TABLE "resupply"."shop_customers"
  DROP CONSTRAINT IF EXISTS "shop_customers_caregiver_shape_chk";
--> statement-breakpoint
ALTER TABLE "resupply"."shop_customers"
  ADD CONSTRAINT "shop_customers_caregiver_shape_chk"
  CHECK (
    -- No caregiver on file → every field null.
    (
      "caregiver_email" IS NULL
      AND "caregiver_name" IS NULL
      AND "caregiver_consent_at" IS NULL
      AND "caregiver_revoked_at" IS NULL
    )
    OR
    -- Caregiver on file → email + name + consent_at all present;
    -- revoked_at may be null (active) or non-null (revoked).
    (
      "caregiver_email" IS NOT NULL
      AND "caregiver_name" IS NOT NULL
      AND "caregiver_consent_at" IS NOT NULL
    )
  );
--> statement-breakpoint

-- Hot query for the dispatcher: active caregivers only. Partial
-- index keeps it tiny since most shop_customers rows have no
-- caregiver attached. Indexed by customer_id so the per-send
-- "does this customer have an active caregiver?" check is a
-- constant-time hit.
CREATE INDEX IF NOT EXISTS "shop_customers_caregiver_active_idx"
  ON "resupply"."shop_customers" ("customer_id")
  WHERE "caregiver_consent_at" IS NOT NULL
    AND "caregiver_revoked_at" IS NULL;
