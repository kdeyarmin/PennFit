-- patient_integration_snapshots — cached unified per-vendor snapshot
-- for the admin "Device data" tab. One row per (patient, source);
-- the row is replaced (UPSERT) every time an admin clicks Refresh
-- on the panel, or every time the nightly worker pulls fresh data.
--
-- We cache rather than always going live to the partner because:
--   1. Partner rate-limits are real (ResMed AirView throttles
--      heavily; Care Orchestrator caps per-DME concurrency).
--   2. Tab paint should be instant — a 3-5s vendor round trip on
--      every patient open would make the admin console feel broken.
--   3. The audit story is cleaner with a stored snapshot: we know
--      exactly what the admin saw, and when.
--
-- The `payload` column stores the unified IntegrationSnapshot shape
-- (DeviceSettings + ComplianceSummary + recentNights[] + supplies[])
-- as jsonb. Schema is enforced at the application boundary by Zod
-- (lib/resupply-integrations/src/types.ts). Keeping it as one jsonb
-- column rather than 4 normalised tables keeps the cache replaceable
-- atomically (a partial write of 3-of-4 sub-tables would be worse
-- than a stale snapshot).
--
-- PHI posture: payload is PHI-adjacent (device serial, supply
-- replacement dates). It lives in plaintext per the post-0025
-- policy — no column-level encryption. Read path is admin-only;
-- audit log records snapshot id + patient id + source only, never
-- the payload contents.
--
-- Per ADR 003 — versioned hand-authored migration.

-- The two existing source-enum check constraints don't include
-- 'health_connect' yet. Drop-and-recreate to widen the value set.
-- Other rows are unaffected.
ALTER TABLE "resupply"."patient_therapy_links"
  DROP CONSTRAINT IF EXISTS "patient_therapy_links_source_enum";

ALTER TABLE "resupply"."patient_therapy_links"
  ADD CONSTRAINT "patient_therapy_links_source_enum"
  CHECK ("source" IN ('resmed_airview', 'philips_care', 'health_connect'));

ALTER TABLE "resupply"."patient_therapy_nights"
  DROP CONSTRAINT IF EXISTS "patient_therapy_nights_source_enum";

ALTER TABLE "resupply"."patient_therapy_nights"
  ADD CONSTRAINT "patient_therapy_nights_source_enum"
  CHECK ("source" IN ('resmed_airview', 'philips_care', 'health_connect', 'manual'));

CREATE TABLE IF NOT EXISTS "resupply"."patient_integration_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Same value space as patient_therapy_links.source — one snapshot
  -- row per (patient, source). UPSERT on conflict.
  "source" text NOT NULL,
  -- Echo of the partner-side patient id at fetch time. Useful for
  -- post-mortem if a link was re-pointed between two refreshes.
  "partner_patient_id" text NOT NULL,
  -- Unified IntegrationSnapshot payload. Validated by Zod at the
  -- application boundary; jsonb so we can index later if needed.
  "payload" jsonb NOT NULL,
  -- 'ok' | 'partial' | 'error'. 'partial' covers the case where one
  -- of the three sub-fetches (settings/sessions/supplies) failed but
  -- the others returned data — we still cache what we got.
  "fetch_status" text NOT NULL DEFAULT 'ok',
  -- Short status string only (auth_failed, not_found, rate_limited,
  -- unavailable, unknown_error). Never a partner response body.
  "fetch_error" text,
  "fetched_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_integration_snapshots_source_enum"
    CHECK ("source" IN ('resmed_airview', 'philips_care', 'health_connect')),
  CONSTRAINT "patient_integration_snapshots_status_enum"
    CHECK ("fetch_status" IN ('ok', 'partial', 'error')),
  -- One snapshot row per (patient, source). UPSERT replaces in place
  -- so the table never grows beyond active links.
  CONSTRAINT "patient_integration_snapshots_unique"
    UNIQUE ("patient_id", "source")
);

-- Common admin lookup path: list all snapshots for one patient.
CREATE INDEX IF NOT EXISTS "patient_integration_snapshots_patient_idx"
  ON "resupply"."patient_integration_snapshots" ("patient_id");

-- Worker freshness scan: "give me snapshots most overdue for refresh."
CREATE INDEX IF NOT EXISTS "patient_integration_snapshots_fetched_idx"
  ON "resupply"."patient_integration_snapshots" ("fetched_at");
