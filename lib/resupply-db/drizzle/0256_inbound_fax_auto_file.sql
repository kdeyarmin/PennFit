-- 0256_inbound_fax_auto_file — automatic barcode filing for inbound faxes.
--
-- Why
-- ---
-- Every document we send out for a provider signature (a prescription
-- request or a signable manual document) is stamped with a short
-- signature-tracking code (PFS-XXXXXXXX) — printed BOTH as a Code 128
-- barcode and as human-readable text — see
-- artifacts/resupply-api/src/lib/barcode/tracking-stamp.ts and the
-- signature_tracking table (0254). Until now a returned signed copy had
-- to be hand-triaged: a CSR opened the inbound fax, found the patient,
-- and either uploaded it to the chart with the code or used the
-- signature-tracking lookup box.
--
-- This migration adds the columns that let the inbound-fax ingest scan a
-- received fax for that tracking code and, on an exact unique match to an
-- outstanding (awaiting_signature) row, automatically:
--   * file the fax into the patient's chart (a patient_documents row),
--   * mark the signature returned & signed (cascading to the source
--     prescription packet), and
--   * satisfy any claim paperwork requirement the tracked document was
--     sent to clear (releasing the bill hold).
-- The code is read via the existing BAA-covered Claude vision path
-- (lib/inbound-fax/tracking-scan.ts) — the same path the on-demand OCR
-- pre-fill uses; it reads the printed PFS- code, not raw patient data.
--
-- Posture: this is OPT-IN behind the `fax.auto_file_signed` feature flag,
-- seeded OFF (filing a clinical document and marking it signed is
-- consequential — mirrors email.auto_reply). With the flag off, inbound
-- faxes triage exactly as before; these columns simply stay NULL.
--
-- Per ADR 003 — versioned hand-authored migration. Plain columns, no RLS;
-- service-role client only. PHI: the fax bytes + chart document live in
-- object storage / patient_documents under their own ACL; this row stores
-- only the opaque tracking code + soft pointers, never patient text.

-- The PFS-XXXXXXXX code we read off the returned fax (NULL when no scan
-- has run or the page carried no PennFit code).
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "tracking_code_detected" text;
--> statement-breakpoint

-- Outcome of the auto-file attempt. NULL means it was never attempted
-- (flag off, or media never persisted). See the CHECK below for the
-- closed set of outcomes; 'filed' is the only terminal-success value.
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "auto_file_status" text;
--> statement-breakpoint

-- When the fax was auto-filed to a chart (only set on 'filed').
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "auto_filed_at" timestamp with time zone;
--> statement-breakpoint

-- The signature_tracking row this fax was matched to (auto). SET NULL if
-- that row is ever removed; the match outcome stays on auto_file_status.
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "signature_tracking_id" uuid
    REFERENCES "resupply"."signature_tracking"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Soft pointer to the patient_documents row we created in the patient's
-- chart. No FK — patient_documents rows are reaped by the retention sweep.
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "chart_document_id" uuid;
--> statement-breakpoint

-- Closed set of auto-file outcomes (DROP+ADD so the migration is
-- idempotent — re-running drops then re-adds the same constraint).
--   filed            — matched an outstanding signature, filed to chart,
--                       marked returned & signed. (terminal success)
--   no_code          — scanned, but the page carried no PennFit code.
--   no_match         — a code was read but no signature_tracking row
--                       matches it.
--   already_returned — matched, but the tracking row was already
--                       returned/canceled (no-op).
--   no_patient       — matched an outstanding row that has no linked
--                       patient, so it can't be filed to a chart (the
--                       signature is still marked returned).
--   failed           — the scan or the chart write errored.
--   unsupported      — the media type can't be scanned.
--   offline          — no AI key configured; nothing scanned.
ALTER TABLE "resupply"."inbound_faxes"
  DROP CONSTRAINT IF EXISTS "inbound_faxes_auto_file_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."inbound_faxes"
  ADD CONSTRAINT "inbound_faxes_auto_file_status_enum"
    CHECK (
      "auto_file_status" IS NULL
      OR "auto_file_status" IN (
        'filed', 'no_code', 'no_match', 'already_returned',
        'no_patient', 'failed', 'unsupported', 'offline'
      )
    );
--> statement-breakpoint

-- Reverse lookup from a signature_tracking row to the fax that filed it
-- (and the small "auto-filed" inbox view). Partial — only the matched rows.
CREATE INDEX IF NOT EXISTS "inbound_faxes_signature_tracking_idx"
  ON "resupply"."inbound_faxes" ("signature_tracking_id")
  WHERE "signature_tracking_id" IS NOT NULL;
--> statement-breakpoint

-- Feature flag. Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts. Seeded OFF: with the
-- flag disabled the ingest never scans and these columns stay NULL, so
-- enabling it later cannot retroactively re-file anything.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('fax.auto_file_signed',
   false,
   'Inbound-fax barcode auto-filing. When ON, every received fax is scanned (via the existing Claude vision path) for the PennFit signature-tracking code (PFS-XXXXXXXX). On an exact unique match to an outstanding signature, the fax is filed into the patient''s chart, the signature is marked returned & signed (advancing the source prescription packet), and any claim paperwork requirement it was sent to clear is satisfied (releasing the bill hold). When OFF, faxes are triaged by hand exactly as before. Degrades to hand-triage whenever no AI key is configured or the scan finds no code.',
   'Operations')
ON CONFLICT (key) DO NOTHING;
