-- 0129_billing_enhancements — denial code catalog, payer fee
-- schedules, ERA file audit trail, plus the provider FKs the 837P
-- builder needs for loops 2310B / 2310D / 2320 / 2330.
--
-- Why
-- ---
-- 0128 closed the catalog gap (payer profiles) and the submission
-- gap (Office Ally 837P). This sprint closes the rest of the
-- billing surface:
--
--   1. The current 837P emits no rendering / referring provider
--      loops. Medicare DME (and most commercial DME) rejects every
--      claim that lacks the prescribing physician's NPI. Adding the
--      FKs here lets the builder populate loops 2310B + 2310D.
--   2. Secondary insurance isn't modeled on the claim — but real
--      patients often carry primary + secondary (Medicare + supplement,
--      commercial + Medicaid). The COB loop 2320/2330 needs to know
--      which secondary coverage to advance to. We add a soft FK so a
--      claim can carry a single explicit secondary; tertiary stays
--      out of scope until volume warrants.
--   3. CSRs translate CARC / RARC denial codes by hand today. Seeding
--      the top ~50 codes is the cheapest, highest-leverage CSR
--      improvement in the billing surface.
--   4. Without a fee schedule, we have no expected-allowed amount to
--      compare to the EOB. Variance triage is the second-biggest
--      revenue leak (the first is denials that never get worked).
--   5. The 835 ERA parser writes one ERA-file row per inbound
--      remittance so we can prove "we received and processed this
--      payer remittance on this date" in an audit.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. ALTER insurance_claims — rendering / referring / secondary FKs.
-- ────────────────────────────────────────────────────────────────────
--
-- All three are soft FKs (ON DELETE SET NULL) so deleting a provider
-- or a secondary coverage row doesn't cascade-delete the claim's
-- history. The 837P builder enforces the presence requirement at
-- submission time, not the schema.
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "rendering_provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "referring_provider_id" uuid
    REFERENCES "resupply"."providers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "secondary_coverage_id" uuid
    REFERENCES "resupply"."insurance_coverages"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_rendering_provider_idx"
  ON "resupply"."insurance_claims" ("rendering_provider_id")
  WHERE "rendering_provider_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_referring_provider_idx"
  ON "resupply"."insurance_claims" ("referring_provider_id")
  WHERE "referring_provider_id" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. denial_codes — CARC / RARC catalog.
-- ────────────────────────────────────────────────────────────────────
--
-- CARC = Claim Adjustment Reason Code (numeric, e.g. 16, 27, 96).
-- RARC = Remittance Advice Remark Code (alphanumeric, MA01, M127).
-- The CMS-managed catalog is the source of truth; we capture the
-- subset that DME suppliers see most often plus the recommended CSR
-- action so the denial worklist isn't a copy-paste of opaque numbers.
--
-- `code_system` distinguishes the two so the same "16" (CARC) and
-- "16" (a hypothetical custom code) never collide on the unique
-- index.
CREATE TABLE IF NOT EXISTS "resupply"."denial_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_system" text NOT NULL,
  "code" varchar(8) NOT NULL,
  "description" varchar(400) NOT NULL,
  "category" text NOT NULL,
  -- Free-text "next step" surfaced in the CSR queue. e.g. for CARC 27
  -- ("Expenses incurred after coverage terminated"), the recommended
  -- action is "verify coverage termination date with payer and bill
  -- the patient for the post-term services".
  "recommended_action" text,
  "is_terminal" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "denial_codes_system_enum"
    CHECK ("code_system" IN ('carc', 'rarc', 'custom')),
  CONSTRAINT "denial_codes_category_enum"
    CHECK ("category" IN (
      'eligibility',
      'authorization',
      'documentation',
      'medical_necessity',
      'duplicate',
      'coverage_limit',
      'coding',
      'cob',
      'patient_liability',
      'timely_filing',
      'other'
    ))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "denial_codes_system_code_uq"
  ON "resupply"."denial_codes" ("code_system", "code");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. payer_fee_schedules — expected allowed cents per (payer, HCPCS).
-- ────────────────────────────────────────────────────────────────────
--
-- One row per payer + HCPCS combination with an effective-date
-- envelope so a rate change can be journaled. The variance helper on
-- the EOB ingest path queries this to flag "Highmark paid us $89.10
-- on E0601 but the published fee schedule allows $122.35" — that's
-- the partial-pay leak we want to chase.
--
-- We DO NOT enforce uniqueness across (payer_profile_id, hcpcs_code,
-- effective_date) overlaps via a constraint — the application layer
-- is responsible for closing prior rows when a new schedule lands.
-- Postgres exclusion constraints across daterange + equals would
-- work but pull in btree_gist; we keep the dependency-light posture
-- of 0118 and 0128.
CREATE TABLE IF NOT EXISTS "resupply"."payer_fee_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "payer_profile_id" uuid NOT NULL
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE CASCADE,
  "hcpcs_code" varchar(12) NOT NULL,
  -- Modifier-aware lookup. NULL = "any modifier" (default rate);
  -- specific modifier values let the schedule split E0601 (NU=new)
  -- vs E0601 (RR=rental) without two HCPCS rows.
  "modifier" varchar(8),
  "allowed_cents" bigint NOT NULL,
  "effective_from" date NOT NULL,
  "effective_through" date,
  "source" text NOT NULL DEFAULT 'manual',
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payer_fee_schedules_allowed_cents_nonneg"
    CHECK ("allowed_cents" >= 0),
  CONSTRAINT "payer_fee_schedules_source_enum"
    CHECK ("source" IN ('manual', 'cms_published', 'payer_published', 'observed')),
  CONSTRAINT "payer_fee_schedules_dates"
    CHECK (
      "effective_through" IS NULL
      OR "effective_through" >= "effective_from"
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_fee_schedules_payer_hcpcs_idx"
  ON "resupply"."payer_fee_schedules"
  ("payer_profile_id", "hcpcs_code", "effective_from" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. era_files — 835 remittance audit trail.
-- ────────────────────────────────────────────────────────────────────
--
-- One row per inbound 835 we process. Holds the file metadata + the
-- parse summary; the per-claim payment events live on
-- insurance_claim_events (event_type IN paid / partial_pay / denied)
-- and the per-line dollar reconciliation lives on
-- insurance_claim_line_items.
--
-- file_sha256 is used to dedupe — Office Ally occasionally redelivers
-- the same 835, and we want the second attempt to be a no-op rather
-- than a duplicate payment event.
CREATE TABLE IF NOT EXISTS "resupply"."era_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "file_name" varchar(160) NOT NULL,
  "file_sha256" varchar(64) NOT NULL UNIQUE,
  "file_size_bytes" integer NOT NULL,
  -- The payer's check / EFT trace number (BPR03 + TRN02 in the 835).
  "payer_check_number" varchar(64),
  "payer_paid_date" date,
  "total_paid_cents" bigint NOT NULL DEFAULT 0,
  -- Counts the parser emits on a successful ingest. Roll-forward is
  -- offline-verifiable: sum(insurance_claim_events.amount_cents
  -- WHERE event_type='paid' AND payer_ref=era_files.payer_check_number)
  -- == era_files.total_paid_cents.
  "claims_paid_count" integer NOT NULL DEFAULT 0,
  "claims_denied_count" integer NOT NULL DEFAULT 0,
  "lines_processed_count" integer NOT NULL DEFAULT 0,
  -- The Office Ally submission this remittance corresponds to (when
  -- the parser can match it). Null on auto-pay payers that send
  -- ERAs without a return reference to our prior 837P.
  "matched_submission_id" uuid
    REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'processed',
  "rejection_reason" text,
  "ingested_by_email" varchar(180) NOT NULL,
  "ingested_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "era_files_status_enum"
    CHECK ("status" IN ('processed', 'parse_failed', 'partial', 'rejected')),
  CONSTRAINT "era_files_counts_nonneg"
    CHECK (
      "file_size_bytes" >= 0
      AND "total_paid_cents" >= 0
      AND "claims_paid_count" >= 0
      AND "claims_denied_count" >= 0
      AND "lines_processed_count" >= 0
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "era_files_ingested_at_idx"
  ON "resupply"."era_files" ("ingested_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "era_files_matched_submission_idx"
  ON "resupply"."era_files" ("matched_submission_id")
  WHERE "matched_submission_id" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 5. SEED denial_codes — top CARC + RARC codes DME suppliers hit.
-- ────────────────────────────────────────────────────────────────────
--
-- The full CMS list has ~400 CARC + ~1000 RARC codes; we seed the
-- subset that appears on >0.1% of DME EOBs based on industry
-- benchmarks. Admin UI lets ops add more without a deploy.
INSERT INTO "resupply"."denial_codes"
  ("code_system", "code", "description", "category", "recommended_action", "is_terminal")
VALUES
  -- ── CARC — eligibility / coverage ──
  ('carc', '24', 'Charges are covered under a capitation agreement/managed care plan',
   'cob', 'Route claim to the patient''s primary MCO; remove from current AR queue.', true),
  ('carc', '26', 'Expenses incurred prior to coverage',
   'eligibility', 'Bill patient directly; verify effective dates with payer.', true),
  ('carc', '27', 'Expenses incurred after coverage terminated',
   'eligibility', 'Verify termination date with payer; bill patient if confirmed.', true),
  ('carc', '29', 'The time limit for filing has expired',
   'timely_filing', 'Appeal with proof of timely submission (OA 999 ack timestamp).', false),
  ('carc', '31', 'Patient cannot be identified as our insured',
   'eligibility', 'Re-verify member ID with patient; correct and resubmit.', false),
  ('carc', '32', 'Our records indicate the patient is not an eligible dependent',
   'eligibility', 'Verify subscriber relationship; correct policyholder_relationship and resubmit.', false),
  ('carc', '33', 'Insured has no dependent coverage',
   'eligibility', 'Confirm the subscriber line of business covers this patient class.', false),
  ('carc', '35', 'Lifetime benefit maximum has been reached',
   'coverage_limit', 'Bill patient; verify with payer for any benefit reset windows.', true),
  -- ── CARC — authorization ──
  ('carc', '197', 'Precertification/authorization/notification/pre-treatment absent',
   'authorization', 'File prior auth retroactively if payer permits; otherwise bill patient.', false),
  ('carc', '198', 'Precertification/notification/authorization/pre-treatment exceeded',
   'authorization', 'Confirm exact PA window; resubmit with corrected DOS or get a new auth.', false),
  -- ── CARC — medical necessity / documentation ──
  ('carc', '50', 'These are non-covered services because this is not deemed a medical necessity by the payer',
   'medical_necessity', 'Appeal with LCD-aligned documentation (sleep study, AHI, compliance).', false),
  ('carc', '167', 'This (these) diagnosis(es) is (are) not covered',
   'medical_necessity', 'Verify diagnosis on prescription; correct ICD-10 and resubmit.', false),
  ('carc', '252', 'An attachment/other documentation is required to adjudicate this claim/service',
   'documentation', 'Send sleep study, Rx, and compliance attestation per LCD L33718.', false),
  -- ── CARC — duplicate / coding ──
  ('carc', '18', 'Exact duplicate claim/service',
   'duplicate', 'Confirm with payer it''s a duplicate (not partial pay); close as duplicate.', true),
  ('carc', '4', 'The procedure code is inconsistent with the modifier used',
   'coding', 'Confirm modifier rules for this HCPCS (KX, RR, NU); correct and resubmit.', false),
  ('carc', '11', 'The diagnosis is inconsistent with the procedure',
   'coding', 'Verify ICD-10 to HCPCS pairing per LCD; correct and resubmit.', false),
  ('carc', '107', 'The related or qualifying claim/service was not identified on this claim',
   'coding', 'Add the qualifying claim ref (parent claim # via REF*F8); resubmit.', false),
  -- ── CARC — COB ──
  ('carc', '22', 'This care may be covered by another payer per coordination of benefits',
   'cob', 'Verify primary payer info; resubmit with COB loop 2320 populated.', false),
  ('carc', '23', 'The impact of prior payer(s) adjudication including payments and/or adjustments',
   'cob', 'Apply prior payer payment + adjustments per the EOB; informational.', false),
  -- ── CARC — patient liability ──
  ('carc', '1', 'Deductible Amount',
   'patient_liability', 'Bill patient for deductible balance.', false),
  ('carc', '2', 'Coinsurance Amount',
   'patient_liability', 'Bill patient for coinsurance.', false),
  ('carc', '3', 'Co-payment Amount',
   'patient_liability', 'Bill patient for copay.', false),
  ('carc', '45', 'Charge exceeds fee schedule/maximum allowable',
   'coverage_limit', 'Informational adjustment; payer-contracted writeoff.', true),
  ('carc', '96', 'Non-covered charge(s)',
   'coverage_limit', 'Bill patient unless ABN was signed and modifier GA/GZ was used.', false),
  ('carc', '109', 'Claim/service not covered by this payer/contractor',
   'eligibility', 'Verify the payer profile + member ID; re-route to correct payer.', false),
  ('carc', '119', 'Benefit maximum for this time period or occurrence has been reached',
   'coverage_limit', 'Check capped-rental cycle; bill patient for the post-cap portion if applicable.', true),
  ('carc', '151', 'Payment adjusted because the payer deems the information submitted does not support this many/frequency of services',
   'medical_necessity', 'Confirm quantity matches PA + LCD frequency rules.', false),
  -- ── RARC — informational ──
  ('rarc', 'M51', 'Missing/incomplete/invalid procedure code(s)',
   'coding', 'Verify HCPCS spelling + length; correct and resubmit.', false),
  ('rarc', 'M52', 'Missing/incomplete/invalid "from" date(s) of service',
   'coding', 'Verify date_of_service on the claim header and service lines.', false),
  ('rarc', 'M64', 'Missing/incomplete/invalid other diagnosis',
   'coding', 'Add or correct secondary diagnosis (HI*ABF) and resubmit.', false),
  ('rarc', 'M127', 'Missing patient medical record for this service',
   'documentation', 'Send the patient''s sleep study and Rx with the appeal.', false),
  ('rarc', 'MA01', 'Alert: If you do not agree with what we approved for these services, you may appeal',
   'other', 'Informational: redetermination window opens with this remit.', false),
  ('rarc', 'MA13', 'Alert: You may be subject to penalties if you bill the patient for amounts not reported with the PR (patient responsibility) group code',
   'patient_liability', 'Informational compliance reminder; bill only PR-group amounts to the patient.', false),
  ('rarc', 'MA28', 'Alert: This service is for information purposes only',
   'other', 'Informational — no action.', false),
  ('rarc', 'MA66', 'Missing/incomplete/invalid principal procedure code',
   'coding', 'Verify principal HCPCS on the claim line; correct and resubmit.', false),
  ('rarc', 'MA92', 'Missing plan information for other insurance',
   'cob', 'Populate loop 2320/2330 with secondary payer information and resubmit.', false),
  ('rarc', 'MA130', 'Your claim contains incomplete and/or invalid information, and no appeal rights are afforded because the claim is unprocessable',
   'documentation', 'Correct the rejection cause from the 277CA and resubmit as new claim.', false),
  ('rarc', 'N122', 'Add-on code cannot be billed by itself',
   'coding', 'Add the primary HCPCS line; resubmit as bundled.', false),
  ('rarc', 'N130', 'Consult plan benefit documents/guidelines for information about restrictions for this service',
   'coverage_limit', 'Verify benefit limits with payer or member portal.', false),
  ('rarc', 'N192', 'Patient is a Medicaid/Qualified Medicare Beneficiary',
   'cob', 'Do not bill patient; route to PA Medicaid MCO.', false),
  ('rarc', 'N211', 'Alert: You may not appeal this decision',
   'other', 'Terminal informational.', true),
  ('rarc', 'N362', 'The number of Days or Units of Service exceeds our acceptable maximum',
   'coverage_limit', 'Confirm units against payer limits; bill patient for excess if ABN-covered.', false),
  ('rarc', 'N390', 'This service/report cannot be billed separately',
   'coding', 'Combine with the parent claim; resubmit as a single bundled claim.', false),
  ('rarc', 'N435', 'Missing/incomplete/invalid attending provider primary identifier',
   'coding', 'Populate loop 2310B with rendering provider NPI; resubmit.', false),
  ('rarc', 'N448', 'This drug/service/supply is not included in the fee schedule or contracted/legislated fee arrangement',
   'coverage_limit', 'Bill patient if non-covered + ABN signed; otherwise writeoff.', false),
  ('rarc', 'N522', 'Duplicate of a claim processed, or to be processed, as a crossover claim',
   'duplicate', 'Confirm Medicare crossover succeeded; close as duplicate.', true),
  ('rarc', 'N554', 'Missing/Incomplete/Invalid Family Planning Indicator',
   'coding', 'Not applicable to DME claims; verify claim was routed to correct payer.', false),
  ('rarc', 'N640', 'Exceeds number/frequency approved/allowed within time period',
   'coverage_limit', 'Wait for the frequency window to open; check resupply schedule.', false),
  ('rarc', 'N742', 'Missing/incomplete/invalid Diagnosis Date',
   'coding', 'Confirm initial diagnosis date on the sleep study record.', false)
ON CONFLICT ("code_system", "code") DO NOTHING;
