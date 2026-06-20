-- 0226_inbound_fax_ocr — AI field extraction for inbound faxes (CSR #C2).
--
-- Faxes arrive as image/PDF and a CSR hand-keys the patient, physician,
-- and document type off the page before they can triage. This adds the
-- columns that hold a one-shot OCR/extraction result so the triage UI can
-- pre-fill those fields. The extraction itself runs through the existing
-- Claude vision path (BAA-covered) on demand from the triage screen — see
-- artifacts/resupply-api/src/lib/inbound-fax/ocr.ts. Fail-soft: when no
-- model key is configured the column simply stays at 'offline' and the
-- CSR keys it by hand exactly as today.
--
--   ocr_status      — 'extracted' | 'failed' | 'unsupported' | 'offline';
--                     NULL means OCR has never been run on this fax.
--   ocr_extraction  — the structured fields (patient/physician/items/…)
--                     as JSON. Only populated when ocr_status='extracted'.
--   ocr_extracted_at — when the extraction last ran.
--
-- PHI: ocr_extraction holds patient-identifying text transcribed from the
-- fax. It lives in the same row as the fax and is never logged.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "ocr_status" text;
--> statement-breakpoint
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "ocr_extraction" jsonb;
--> statement-breakpoint
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "ocr_extracted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "resupply"."inbound_faxes"
  DROP CONSTRAINT IF EXISTS "inbound_faxes_ocr_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."inbound_faxes"
  ADD CONSTRAINT "inbound_faxes_ocr_status_enum"
    CHECK (
      "ocr_status" IS NULL
      OR "ocr_status" IN ('extracted', 'failed', 'unsupported', 'offline')
    );
