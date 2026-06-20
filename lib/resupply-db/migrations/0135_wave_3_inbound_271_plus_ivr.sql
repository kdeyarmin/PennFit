-- 0135_wave_3_inbound_271_plus_ivr — Wave 3 of the gap-analysis
-- roadmap. Two small schema deltas needed before the new code:
--
--   1. Extend clearinghouse_inbound_files.file_kind to include '271'
--      so the inbound poller can dispatch eligibility responses.
--   2. ALTER eligibility_checks to add a downloaded-file pointer
--      (so the audit shows which inbound 271 settled each check).
--
-- The bulk of Wave 3 — AI inbound IVR, Da Vinci PAS client, FHIR R4
-- patient endpoint — needs no schema additions beyond the
-- voice_reorder_sessions + davinci_pas_submissions tables that
-- shipped in migration 0134.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."clearinghouse_inbound_files"
  DROP CONSTRAINT IF EXISTS "clearinghouse_inbound_files_kind_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."clearinghouse_inbound_files"
  ADD CONSTRAINT "clearinghouse_inbound_files_kind_enum"
    CHECK ("file_kind" IN ('999', '277ca', '835', '271', 'unknown'));
--> statement-breakpoint

ALTER TABLE "resupply"."eligibility_checks"
  ADD COLUMN IF NOT EXISTS "applied_to_inbound_file_id" uuid
    REFERENCES "resupply"."clearinghouse_inbound_files"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "eligibility_checks_inbound_file_idx"
  ON "resupply"."eligibility_checks" ("applied_to_inbound_file_id")
  WHERE "applied_to_inbound_file_id" IS NOT NULL;
