-- 0397 — Phone line type (cell vs. landline/VoIP) for patients + shop customers.
--
-- Adds a classified line type to each phone on file so the app can tell
-- whether a number is a CELL — and so bulk-campaign SMS only goes to
-- cellular numbers. The classification is populated by Twilio Lookup v2
-- (line_type_intelligence) and can be manually overridden by staff:
--
--   * phone_line_type           — 'mobile' | 'landline' | 'voip' | 'unknown'.
--                                 NULL = never classified yet.
--   * phone_line_type_source    — 'lookup' (Twilio) | 'manual' (staff
--                                 override). A 'manual' value is authoritative
--                                 and the lookup/backfill never overwrites it.
--   * phone_line_type_checked_at — when the value was last set.
--
-- SMS gating policy (see lib/bulk-campaigns/resolve-audience.ts +
-- worker/jobs/bulk-campaign-tick.ts): SMS is suppressed for a recipient whose
-- line type is a KNOWN non-mobile ('landline'/'voip'); 'mobile' and the
-- not-yet-classified states (NULL / 'unknown') are allowed to send.
--
-- IMPORTANT — journal posture: not listed in _journal.json, matching the
-- established pattern for migrations 0050+. Forward-deploy-safe: every
-- statement is guarded (ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS
-- then ADD), so a re-run is idempotent.

-- ── patients ────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "phone_line_type" text,
  ADD COLUMN IF NOT EXISTS "phone_line_type_source" text,
  ADD COLUMN IF NOT EXISTS "phone_line_type_checked_at" timestamp with time zone;

ALTER TABLE "resupply"."patients"
  DROP CONSTRAINT IF EXISTS "patients_phone_line_type_enum";
ALTER TABLE "resupply"."patients"
  ADD CONSTRAINT "patients_phone_line_type_enum"
    CHECK ("phone_line_type" IS NULL
      OR "phone_line_type" IN ('mobile', 'landline', 'voip', 'unknown'));

ALTER TABLE "resupply"."patients"
  DROP CONSTRAINT IF EXISTS "patients_phone_line_type_source_enum";
ALTER TABLE "resupply"."patients"
  ADD CONSTRAINT "patients_phone_line_type_source_enum"
    CHECK ("phone_line_type_source" IS NULL
      OR "phone_line_type_source" IN ('lookup', 'manual'));

-- ── shop_customers ──────────────────────────────────────────────────────────
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "phone_line_type" text,
  ADD COLUMN IF NOT EXISTS "phone_line_type_source" text,
  ADD COLUMN IF NOT EXISTS "phone_line_type_checked_at" timestamp with time zone;

ALTER TABLE "resupply"."shop_customers"
  DROP CONSTRAINT IF EXISTS "shop_customers_phone_line_type_enum";
ALTER TABLE "resupply"."shop_customers"
  ADD CONSTRAINT "shop_customers_phone_line_type_enum"
    CHECK ("phone_line_type" IS NULL
      OR "phone_line_type" IN ('mobile', 'landline', 'voip', 'unknown'));

ALTER TABLE "resupply"."shop_customers"
  DROP CONSTRAINT IF EXISTS "shop_customers_phone_line_type_source_enum";
ALTER TABLE "resupply"."shop_customers"
  ADD CONSTRAINT "shop_customers_phone_line_type_source_enum"
    CHECK ("phone_line_type_source" IS NULL
      OR "phone_line_type_source" IN ('lookup', 'manual'));
