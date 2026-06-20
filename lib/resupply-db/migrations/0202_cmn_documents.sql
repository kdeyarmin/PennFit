-- 0202_cmn_documents — Biller #29: Certificate of Medical Necessity /
-- DME Information Form, as a dedicated STRUCTURED document.
--
-- Note: `dwo_documents` (migration 0134) already tracks CMN/DWO/SWO as a
-- renewal/expiry record (form_type, signed/expires dates, a signed-PDF
-- object key) and feeds claim documentation packets. This table is the
-- complement the owner asked for: the form's STRUCTURED contents — the
-- per-form-type question/answer set + a completeness validation — which
-- dwo_documents does not capture. A cmn_documents row may reference the
-- dwo_documents row that holds the signed PDF (soft link, no FK so either
-- can exist independently).
--
--   * form_type   — the CMS form catalog (see lib/billing/cmn-forms.ts):
--                   cms_484 (oxygen), cms_846, cms_847, cms_848,
--                   dif_10125 (external infusion), dif_10126 (enteral).
--   * hcpcs_code  — the item this CMN justifies.
--   * answers     — jsonb of the form's structured Q&A.
--   * status      — draft → completed → on_file | voided. The route
--                   refuses 'completed' until validateCmnAnswers passes.
--
-- Additive, no backfill. Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."cmn_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Optional link to the claim this CMN supports (claim may post later).
  "claim_id" uuid
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE SET NULL,
  -- Soft link to the dwo_documents row holding the signed PDF (no FK).
  "dwo_document_id" uuid,
  "form_type" text NOT NULL,
  "hcpcs_code" varchar(12) NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "answers" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "physician_name" text,
  "physician_npi" varchar(10),
  "initial_date" date,
  "recert_date" date,
  "length_of_need_months" integer,
  "created_by_email" text NOT NULL DEFAULT 'unknown',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cmn_documents_status_enum"
    CHECK ("status" IN ('draft', 'completed', 'on_file', 'voided')),
  CONSTRAINT "cmn_documents_length_of_need_nonneg"
    CHECK ("length_of_need_months" IS NULL OR "length_of_need_months" >= 0)
);
--> statement-breakpoint

-- Patient CMN list, newest first.
CREATE INDEX IF NOT EXISTS "cmn_documents_patient_created_idx"
  ON "resupply"."cmn_documents" ("patient_id", "created_at" DESC);
--> statement-breakpoint
-- Worklist scans drafts / by status.
CREATE INDEX IF NOT EXISTS "cmn_documents_status_idx"
  ON "resupply"."cmn_documents" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cmn_documents_claim_idx"
  ON "resupply"."cmn_documents" ("claim_id");
