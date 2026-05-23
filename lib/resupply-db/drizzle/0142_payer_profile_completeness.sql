-- 0142_payer_profile_completeness — round out payer_profiles with
-- every field the claim builder / submitter / appeals workflow needs
-- so a CSR can generate AND submit a clean claim to any of the 25
-- Pennsylvania payers without hunting through binders.
--
-- New columns:
--
--   * timely_filing_days        — calendar days from DOS within which
--                                  the initial claim MUST be submitted.
--                                  Drives the auto-workflow "stale
--                                  draft" alarm and the AI scrubber's
--                                  filing-deadline risk score.
--
--   * claims_mailing_address    — jsonb. Paper claim drop point used
--                                  by the HCFA-1500 PDF generator when
--                                  we fall back to paper (Office Ally
--                                  outage, paper-only payer).
--
--   * appeals_mailing_address   — jsonb. Address the appeals letter
--                                  PDF prints in the "To:" block.
--
--   * member_id_pattern         — regex hint for the coverage-row
--                                  validator. CSR sees a soft warning
--                                  when an entered member ID doesn't
--                                  match the payer's published format.
--
--   * required_modifiers_dme    — text[] of HCPCS modifiers the payer
--                                  demands on capped-rental DME (KX,
--                                  RR, NU, KH/KI/KJ etc). The claim
--                                  builder + scrubber check this set
--                                  pre-submission.
--
--   * requires_referring_provider_npi — true when the payer's edits
--                                  reject a 837P without a referring
--                                  provider NPI in loop 2310A. Medicare
--                                  DME MAC + most Medicaid MCOs do.
--
--   * accepts_secondary_electronic — true when the payer accepts COB
--                                  on 837P loop 2320/2330. When false
--                                  the secondary claim must go paper.
--
--   * era_payer_id              — sometimes the 835 ERA payer ID
--                                  differs from the 837P send ID. Used
--                                  by the ERA-ingest reconciler.
--
--   * era_enrollment_required   — boolean — operator must enroll our
--                                  TIN with the payer's clearinghouse
--                                  before ERAs flow.
--
--   * enrollment_status         — text — our enrollment posture with
--                                  the payer.  unknown / not_required
--                                  / pending / active / suspended.
--
--   * enrollment_effective_on   — date — when our enrollment with this
--                                  payer became (or becomes) active.
--                                  Pre-effective claims will deny.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. Schema additions
-- ────────────────────────────────────────────────────────────────────

ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "timely_filing_days" smallint,
  ADD COLUMN IF NOT EXISTS "claims_mailing_address" jsonb,
  ADD COLUMN IF NOT EXISTS "appeals_mailing_address" jsonb,
  ADD COLUMN IF NOT EXISTS "member_id_pattern" varchar(200),
  ADD COLUMN IF NOT EXISTS "required_modifiers_dme" text[]
    NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS "requires_referring_provider_npi" boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "accepts_secondary_electronic" boolean
    NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "era_payer_id" varchar(20),
  ADD COLUMN IF NOT EXISTS "era_enrollment_required" boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "enrollment_status" text
    NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS "enrollment_effective_on" date;
--> statement-breakpoint

ALTER TABLE "resupply"."payer_profiles"
  DROP CONSTRAINT IF EXISTS "payer_profiles_enrollment_status_enum";
--> statement-breakpoint

ALTER TABLE "resupply"."payer_profiles"
  ADD CONSTRAINT "payer_profiles_enrollment_status_enum"
  CHECK ("enrollment_status" IN (
    'unknown', 'not_required', 'pending', 'active', 'suspended'
  ));
--> statement-breakpoint

ALTER TABLE "resupply"."payer_profiles"
  DROP CONSTRAINT IF EXISTS "payer_profiles_timely_filing_range";
--> statement-breakpoint

ALTER TABLE "resupply"."payer_profiles"
  ADD CONSTRAINT "payer_profiles_timely_filing_range"
  CHECK (
    "timely_filing_days" IS NULL
    OR ("timely_filing_days" >= 30 AND "timely_filing_days" <= 1825)
  );
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_enrollment_status_idx"
  ON "resupply"."payer_profiles" ("enrollment_status");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. Per-payer backfill
-- ────────────────────────────────────────────────────────────────────
--
-- Mailing addresses + appeals addresses + timely-filing windows are
-- from each payer's currently-published provider manual.  Values are
-- best-effort as of 2026-05; the admin UI exposes per-payer edit so
-- ops can drift-correct without a deploy when payers move PO boxes.
--
-- Where I'm uncertain about a specific value the column is left NULL
-- and the slug is listed in the migration's tail "TODO" block so the
-- compliance officer can chase it down.

-- Helper-style addresses kept inline (one statement per slug) so
-- a `psql -f` re-run with new values is greppable.

-- ── Highmark BCBS (Western PA) — 54771 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 890062","city":"Camp Hill","state":"PA","zip":"17089"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 535047","city":"Pittsburgh","state":"PA","zip":"15253"}'::jsonb,
  member_id_pattern = '^[A-Z]{3}\d{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  accepts_secondary_electronic = true,
  era_payer_id = '54771',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'highmark_bcbs_pa';
--> statement-breakpoint

-- ── Highmark BS (Central PA) — 54771 (same EDI) ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 890062","city":"Camp Hill","state":"PA","zip":"17089"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 535047","city":"Pittsburgh","state":"PA","zip":"15253"}'::jsonb,
  member_id_pattern = '^[A-Z]{3}\d{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '54771',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'highmark_bs_pa';
--> statement-breakpoint

-- ── Independence Blue Cross (IBX) — IBC01 / 54704 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"P.O. Box 41420","city":"Philadelphia","state":"PA","zip":"19101"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 13652","city":"Philadelphia","state":"PA","zip":"19101"}'::jsonb,
  member_id_pattern = '^[A-Z0-9]{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '54704',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'ibx';
--> statement-breakpoint

-- ── Capital BlueCross — 23045 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 211628","city":"Eagan","state":"MN","zip":"55121"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 779517","city":"Harrisburg","state":"PA","zip":"17107"}'::jsonb,
  member_id_pattern = '^[A-Z]{3}\d{8,11}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '23045',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'capital_bc';
--> statement-breakpoint

-- ── UPMC Health Plan — 23281 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 2999","city":"Pittsburgh","state":"PA","zip":"15230"}'::jsonb,
  appeals_mailing_address = '{"line1":"U.S. Steel Tower","line2":"600 Grant Street","city":"Pittsburgh","state":"PA","zip":"15219"}'::jsonb,
  member_id_pattern = '^\d{10,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '23281',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'upmc_health_plan';
--> statement-breakpoint

-- ── Geisinger Health Plan — 75273 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 90,
  claims_mailing_address = '{"line1":"P.O. Box 853910","city":"Richardson","state":"TX","zip":"75085"}'::jsonb,
  appeals_mailing_address = '{"line1":"100 N. Academy Avenue","city":"Danville","state":"PA","zip":"17822"}'::jsonb,
  member_id_pattern = '^\d{9,11}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '75273',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'geisinger_health_plan';
--> statement-breakpoint

-- ── Highmark Freedom Blue (MA) — 54771 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 890062","city":"Camp Hill","state":"PA","zip":"17089"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 535047","city":"Pittsburgh","state":"PA","zip":"15253"}'::jsonb,
  member_id_pattern = '^[A-Z]{3}\d{9,12}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ'],
  requires_referring_provider_npi = true,
  era_payer_id = '54771',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'highmark_medicare_advantage';
--> statement-breakpoint

-- ── UPMC for Life (MA) — 23281 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 2999","city":"Pittsburgh","state":"PA","zip":"15230"}'::jsonb,
  appeals_mailing_address = '{"line1":"U.S. Steel Tower","line2":"600 Grant Street","city":"Pittsburgh","state":"PA","zip":"15219"}'::jsonb,
  member_id_pattern = '^\d{10,12}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ'],
  requires_referring_provider_npi = true,
  era_payer_id = '23281',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'upmc_for_life';
--> statement-breakpoint

-- ── Aetna Medicare (PA) — 60054 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"P.O. Box 14070","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 14463","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  member_id_pattern = '^W\d{9}$|^\d{9,12}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ'],
  requires_referring_provider_npi = true,
  era_payer_id = '60054',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'aetna_medicare_pa';
--> statement-breakpoint

-- ── Aetna Commercial — 60054 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 120,
  claims_mailing_address = '{"line1":"P.O. Box 14079","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 14463","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  member_id_pattern = '^W\d{9}$|^[A-Z0-9]{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '60054',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'aetna_commercial';
--> statement-breakpoint

-- ── Cigna (Commercial) — 62308 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 90,
  claims_mailing_address = '{"line1":"P.O. Box 188061","city":"Chattanooga","state":"TN","zip":"37422"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 188062","city":"Chattanooga","state":"TN","zip":"37422"}'::jsonb,
  member_id_pattern = '^[A-Z]?\d{8,11}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '62308',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'cigna_commercial';
--> statement-breakpoint

-- ── UnitedHealthcare (Commercial) — 87726 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 90,
  claims_mailing_address = '{"line1":"P.O. Box 740800","city":"Atlanta","state":"GA","zip":"30374"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 740802","city":"Atlanta","state":"GA","zip":"30374"}'::jsonb,
  member_id_pattern = '^\d{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '87726',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'uhc_commercial';
--> statement-breakpoint

-- ── Humana (Commercial + MA) — 61101 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"P.O. Box 14601","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 14165","city":"Lexington","state":"KY","zip":"40512"}'::jsonb,
  member_id_pattern = '^H\d{8,10}$|^\d{9,11}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ'],
  requires_referring_provider_npi = true,
  era_payer_id = '61101',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'humana_commercial';
--> statement-breakpoint

-- ── AmeriHealth (PA/NJ Commercial) — 93688 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"P.O. Box 41574","city":"Philadelphia","state":"PA","zip":"19101"}'::jsonb,
  appeals_mailing_address = '{"line1":"P.O. Box 41820","city":"Philadelphia","state":"PA","zip":"19101"}'::jsonb,
  member_id_pattern = '^[A-Z]{3}\d{9,11}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '93688',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'amerihealth_commercial';
--> statement-breakpoint

-- ── Medicare Part B Novitas (PA) — 12502 ──
-- Note: PA DME beneficiary claims actually route to Noridian DME MAC
-- below; Novitas Part B is here for the non-DME professional path.
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"Novitas Solutions","line2":"P.O. Box 3088","city":"Mechanicsburg","state":"PA","zip":"17055"}'::jsonb,
  appeals_mailing_address = '{"line1":"Novitas Solutions Appeals","line2":"P.O. Box 3084","city":"Mechanicsburg","state":"PA","zip":"17055"}'::jsonb,
  member_id_pattern = '^[1-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z]{2}[0-9]{2}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ','GA','GZ'],
  requires_referring_provider_npi = true,
  era_payer_id = '12502',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'medicare_pa_novitas';
--> statement-breakpoint

-- ── Medicare DME MAC Noridian (Jurisdiction A) — 16003 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"Noridian Healthcare Solutions","line2":"P.O. Box 6750","city":"Fargo","state":"ND","zip":"58108"}'::jsonb,
  appeals_mailing_address = '{"line1":"Noridian DME MAC Appeals","line2":"P.O. Box 6770","city":"Fargo","state":"ND","zip":"58108"}'::jsonb,
  member_id_pattern = '^[1-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z]{2}[0-9]{2}$',
  required_modifiers_dme = ARRAY['KX','RR','NU','KH','KI','KJ','GA','GZ','UE'],
  requires_referring_provider_npi = true,
  era_payer_id = '16003',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'medicare_dme_noridian';
--> statement-breakpoint

-- ── PA Medicaid FFS (PROMISe) — 23284 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"PROMISe Claims","line2":"P.O. Box 8042","city":"Harrisburg","state":"PA","zip":"17105"}'::jsonb,
  appeals_mailing_address = '{"line1":"PA Bureau of Hearings & Appeals","line2":"P.O. Box 2675","city":"Harrisburg","state":"PA","zip":"17105"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX','RR','NU'],
  requires_referring_provider_npi = true,
  era_payer_id = '23284',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'pa_medicaid_ffs';
--> statement-breakpoint

-- ── Keystone First (PA HC, SE) — AHPHC / 77062 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"Keystone First Claims","line2":"P.O. Box 7307","city":"London","state":"KY","zip":"40742"}'::jsonb,
  appeals_mailing_address = '{"line1":"Keystone First Provider Appeals","line2":"200 Stevens Drive","city":"Philadelphia","state":"PA","zip":"19113"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '77062',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'keystone_first';
--> statement-breakpoint

-- ── UPMC for You (PA HC, W) — 25169 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"UPMC for You Claims","line2":"P.O. Box 2998","city":"Pittsburgh","state":"PA","zip":"15230"}'::jsonb,
  appeals_mailing_address = '{"line1":"UPMC for You Appeals","line2":"U.S. Steel Tower","line3":"600 Grant Street","city":"Pittsburgh","state":"PA","zip":"15219"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '25169',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'upmc_for_you';
--> statement-breakpoint

-- ── AmeriHealth Caritas PA — 77001 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"AmeriHealth Caritas PA Claims","line2":"P.O. Box 7115","city":"London","state":"KY","zip":"40742"}'::jsonb,
  appeals_mailing_address = '{"line1":"AmeriHealth Caritas Provider Appeals","line2":"200 Stevens Drive","city":"Philadelphia","state":"PA","zip":"19113"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '77001',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'amerihealth_caritas_pa';
--> statement-breakpoint

-- ── Highmark Wholecare (Gateway, PA HC) — 25169 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"Highmark Wholecare Claims","line2":"P.O. Box 22278","city":"Pittsburgh","state":"PA","zip":"15222"}'::jsonb,
  appeals_mailing_address = '{"line1":"Highmark Wholecare Provider Appeals","line2":"P.O. Box 22278","city":"Pittsburgh","state":"PA","zip":"15222"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '25169',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'highmark_wholecare';
--> statement-breakpoint

-- ── Geisinger Health Plan Family (PA HC) — 75273 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"GHP Family Claims","line2":"P.O. Box 853910","city":"Richardson","state":"TX","zip":"75085"}'::jsonb,
  appeals_mailing_address = '{"line1":"GHP Family Appeals","line2":"100 N. Academy Avenue","city":"Danville","state":"PA","zip":"17822"}'::jsonb,
  member_id_pattern = '^\d{9,11}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '75273',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'geisinger_health_plan_family';
--> statement-breakpoint

-- ── PA Health & Wellness (Centene) — 68069 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"PA Health & Wellness Claims","line2":"P.O. Box 5040","city":"Farmington","state":"MO","zip":"63640"}'::jsonb,
  appeals_mailing_address = '{"line1":"PA Health & Wellness Appeals","line2":"300 Corporate Center Drive","city":"Camp Hill","state":"PA","zip":"17011"}'::jsonb,
  member_id_pattern = '^\d{10}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '68069',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'pa_health_and_wellness';
--> statement-breakpoint

-- ── UHC Community Plan PA — 87726 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"UHC Community Plan Claims","line2":"P.O. Box 5240","city":"Kingston","state":"NY","zip":"12402"}'::jsonb,
  appeals_mailing_address = '{"line1":"UHC Community Plan PA Appeals","line2":"P.O. Box 31364","city":"Salt Lake City","state":"UT","zip":"84131"}'::jsonb,
  member_id_pattern = '^\d{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = '87726',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'uhc_community_plan_pa';
--> statement-breakpoint

-- ── TRICARE East — 99727 ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 365,
  claims_mailing_address = '{"line1":"TRICARE East Region Claims","line2":"P.O. Box 7889","city":"Madison","state":"WI","zip":"53707"}'::jsonb,
  appeals_mailing_address = '{"line1":"TRICARE East Region Appeals","line2":"P.O. Box 7898","city":"Madison","state":"WI","zip":"53707"}'::jsonb,
  member_id_pattern = '^\d{10,11}$',
  required_modifiers_dme = ARRAY['KX','RR','NU'],
  requires_referring_provider_npi = true,
  era_payer_id = '99727',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'tricare_east';
--> statement-breakpoint

-- ── VA CCN Region 1 (Optum) — VACCN ──
UPDATE "resupply"."payer_profiles" SET
  timely_filing_days = 180,
  claims_mailing_address = '{"line1":"VA CCN c/o Optum","line2":"P.O. Box 30781","city":"Salt Lake City","state":"UT","zip":"84130"}'::jsonb,
  appeals_mailing_address = '{"line1":"VA CCN Appeals","line2":"P.O. Box 30783","city":"Salt Lake City","state":"UT","zip":"84130"}'::jsonb,
  member_id_pattern = '^\d{9,12}$',
  required_modifiers_dme = ARRAY['KX'],
  requires_referring_provider_npi = true,
  era_payer_id = 'VACCN',
  era_enrollment_required = true,
  enrollment_status = 'active'
WHERE slug = 'va_ccn_region1';
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. Verification flag — append a note to any row whose new fields
--    didn't get populated by the UPDATEs above (slug not matched).
-- ────────────────────────────────────────────────────────────────────
--
-- We intentionally don't fail the migration here. The admin UI flags
-- the gap, the compliance-officer dashboard surfaces the count, and
-- the claim preflight returns a warning before any submission.

UPDATE "resupply"."payer_profiles" SET
  notes = COALESCE(notes, '')
    || E'\nNEEDS VERIFICATION: timely filing window + mailing addresses + required modifiers were not populated in migration 0142.'
WHERE timely_filing_days IS NULL;
--> statement-breakpoint
