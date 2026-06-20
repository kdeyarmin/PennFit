-- 0321_referral_reviews — AI referral intake reviews (fax + manual upload).
--
-- Why
-- ---
-- New-patient referrals arrive as multi-document fax packets (demographics
-- sheet, insurance info, physician order, sleep study) and a CSR re-keys
-- everything by hand from the inbound-fax triage queue. This table backs
-- the Referral Reviewer: when a referral packet arrives by fax (flag-gated)
-- or is uploaded as a PDF by staff, the packet is run once through the
-- existing Claude document path and the structured extraction (patient
-- demographics, insurance, ordered items, sleep-study results, referring
-- physician, and a per-section page-range map) is stored here for human
-- review. The CSR edits the extracted fields, optionally runs a 270/271
-- eligibility quick-check on the extracted insurance, and then explicitly
-- accepts ("Enter this referral into the system?") — which creates the
-- patient row, the insurance_coverages rows, and files the split,
-- per-section PDFs into patient_documents. Nothing is created without
-- that explicit accept.
--
-- This is NOT a revival of the inbound-referral subsystem dropped in 0295
-- (Parachute / EHR-FHIR vendor integrations). Referrals flow through the
-- retained inbound_faxes channel; a review row simply layers the AI
-- extraction + accept lifecycle on top (or on an uploaded PDF that has no
-- fax row at all — which is why this is its own table rather than columns
-- on inbound_faxes).
--
-- Per ADR 003 — versioned hand-authored migration. Plain columns, no RLS;
-- service-role client only. PHI: `extraction` holds patient-identifying
-- text transcribed from the referral; it lives only in this row and the
-- object-storage bytes it was read from, both behind admin-gated routes.
-- Log lines carry status/ids only, never the extraction.

CREATE TABLE IF NOT EXISTS "resupply"."referral_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where the packet came from. 'fax' rows carry inbound_fax_id; 'upload'
  -- rows were PUT directly by an admin and have no fax.
  "source" text NOT NULL,

  -- The fax this review was opened for (null for uploads). SET NULL so
  -- deleting a fax row never strands the review mid-edit.
  "inbound_fax_id" uuid
    REFERENCES "resupply"."inbound_faxes"("id") ON DELETE SET NULL,

  -- Media pointer — copied from the fax row at enqueue time, or set by the
  -- upload finalize. Always populated for a live review so media streaming
  -- and accept work identically for both sources.
  "media_object_key" text,
  "media_content_type" text,
  "media_size_bytes" integer,

  -- Review lifecycle.
  --   pending     — created, extraction not yet run (or enqueue failed;
  --                  the re-run route recovers it).
  --   extracted   — extraction persisted, awaiting human review.
  --   accepted    — CSR accepted; patient + documents created.
  --   dismissed   — CSR decided this is not a referral to enter.
  --   failed      — model call / parse errored (re-runnable).
  --   offline     — no AI key configured (re-runnable once one is).
  --   unsupported — media type the model can't read (e.g. TIFF).
  "status" text NOT NULL DEFAULT 'pending',

  -- The structured extraction, persisted verbatim as validated (see
  -- referralExtractionSchema in
  -- artifacts/resupply-api/src/lib/referral-review/extract.ts).
  "extraction" jsonb,
  "extraction_model" text,
  "extracted_at" timestamp with time zone,
  -- PHI-free machine reason for failed/unsupported (an error code, never
  -- document text).
  "error_reason" text,

  -- Set on accept. SET NULL so deleting the patient (merge cleanup etc.)
  -- keeps the review history.
  "created_patient_id" uuid
    REFERENCES "resupply"."patients"("id") ON DELETE SET NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid,
  "dismissed_at" timestamp with time zone,
  "dismissed_by_user_id" uuid,
  "dismiss_note" text,

  -- The admin who uploaded the packet (null for fax rows).
  "created_by_user_id" uuid,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "resupply"."referral_reviews"
  DROP CONSTRAINT IF EXISTS "referral_reviews_source_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."referral_reviews"
  ADD CONSTRAINT "referral_reviews_source_enum"
    CHECK ("source" IN ('fax', 'upload'));
--> statement-breakpoint

ALTER TABLE "resupply"."referral_reviews"
  DROP CONSTRAINT IF EXISTS "referral_reviews_status_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."referral_reviews"
  ADD CONSTRAINT "referral_reviews_status_enum"
    CHECK ("status" IN (
      'pending', 'extracted', 'accepted', 'dismissed',
      'failed', 'offline', 'unsupported'
    ));
--> statement-breakpoint

-- One review per fax (uploads are unconstrained — each upload is its own
-- review). Partial so the NULLs from uploads don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS "referral_reviews_fax_unique"
  ON "resupply"."referral_reviews" ("inbound_fax_id")
  WHERE "inbound_fax_id" IS NOT NULL;
--> statement-breakpoint

-- The open-queue read path: reviews awaiting extraction or human review,
-- newest first.
CREATE INDEX IF NOT EXISTS "referral_reviews_open_idx"
  ON "resupply"."referral_reviews" ("status", "created_at" DESC)
  WHERE "status" IN ('pending', 'extracted');
--> statement-breakpoint

-- Patient-detail back-reference ("created from referral …").
CREATE INDEX IF NOT EXISTS "referral_reviews_created_patient_idx"
  ON "resupply"."referral_reviews" ("created_patient_id")
  WHERE "created_patient_id" IS NOT NULL;
--> statement-breakpoint

-- Feature flag. Keep in sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts. Seeded OFF (mirrors
-- fax.auto_file_signed): with the flag off, inbound faxes triage exactly
-- as before and no model tokens are spent; the manual "Upload referral
-- PDF" path and the on-demand re-run button still work regardless of the
-- flag, because those are explicit human actions.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('fax.referral_review',
   false,
   'AI referral reviewer for inbound faxes. When ON, every received fax that is not barcode auto-filed is queued for one AI extraction pass (Claude document path) that pulls the referral''s patient demographics, insurance, ordered items, sleep-study results, and referring physician into a review the staff can edit and explicitly accept — accepting creates the patient record, the insurance coverage, and files the split per-section PDFs to the chart. Nothing is entered into the system without that explicit accept. When OFF, faxes triage exactly as before; the manual "Upload referral PDF" reviewer remains available either way. Degrades to hand-triage when no AI key is configured.',
   'Operations')
ON CONFLICT (key) DO NOTHING;
