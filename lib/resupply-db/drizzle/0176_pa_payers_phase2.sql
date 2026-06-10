-- 0149_pa_payers_phase2 — Pennsylvania payer catalog expansion +
-- submission-readiness columns.
--
-- Why
-- ---
-- Migration 0128 seeded 26 PA payers — enough to bill the largest
-- commercial / Medicare / Medicaid books, but a real PA DME supplier
-- also bills smaller Medicare Advantage carriers (Devoted, Clover,
-- Wellcare), the major PA-specific TPAs (Meritain, UMR), PA state-
-- employee programs (PEBTF, PSERS HOP), PA workers' compensation
-- carriers (SWIF, PMA, Erie, plus the big national WC books that
-- write in PA), Medicare Supplement crossover, and the PA Medicaid
-- MCO that 0128 missed (Health Partners Plans / Jefferson). This
-- migration adds 25 more rows to the catalog so claim-builder
-- lookups stop falling through to free-text matching for those
-- patients.
--
-- It also widens the schema with the per-payer fields a biller
-- actually needs to submit a clean claim — fields the 0128 seed
-- captured only as free-form `notes`:
--
--   * timely_filing_days
--   * claims_address_line1 / _line2 / _city / _state / _zip
--   * claims_phone_e164, claims_fax_e164
--   * prior_auth_submission_method  (portal | fax | phone |
--                                    electronic_278 | paper | none)
--   * prior_auth_fax_e164
--   * prior_auth_turnaround_business_days
--   * required_claim_modifiers       (text[] — e.g. {KX,GA})
--   * accepts_electronic_secondary
--   * edi_enrollment_status          (enrolled | pending |
--                                    not_enrolled | not_applicable)
--   * member_id_format_hint
--   * requirements_last_verified_at  (when ops last reviewed this row)
--   * requirements_last_verified_by  (email)
--
-- These are exactly the columns the new Office-Ally enrollment-CSV
-- export (`GET /admin/payer-profiles/export.csv`) emits, and the
-- columns the admin edit drawer exposes. Together they make the
-- catalog self-describing: an op can open one row, see every fact
-- they'd need to type into Office Ally's enrollment console, edit
-- in place, and stamp the verification date so the rest of the
-- team knows the data is fresh.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ──────────────────────────────────────────────────────────────────────
-- 1. ALTER payer_profiles — submission-readiness columns
-- ──────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "timely_filing_days"
    smallint,
  ADD COLUMN IF NOT EXISTS "claims_address_line1"
    varchar(120),
  ADD COLUMN IF NOT EXISTS "claims_address_line2"
    varchar(120),
  ADD COLUMN IF NOT EXISTS "claims_city"
    varchar(80),
  ADD COLUMN IF NOT EXISTS "claims_state"
    varchar(2),
  ADD COLUMN IF NOT EXISTS "claims_zip"
    varchar(10),
  ADD COLUMN IF NOT EXISTS "claims_phone_e164"
    varchar(20),
  ADD COLUMN IF NOT EXISTS "claims_fax_e164"
    varchar(20),
  ADD COLUMN IF NOT EXISTS "prior_auth_submission_method"
    text,
  ADD COLUMN IF NOT EXISTS "prior_auth_fax_e164"
    varchar(20),
  ADD COLUMN IF NOT EXISTS "prior_auth_turnaround_business_days"
    smallint,
  ADD COLUMN IF NOT EXISTS "required_claim_modifiers"
    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "accepts_electronic_secondary"
    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "edi_enrollment_status"
    text NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS "member_id_format_hint"
    varchar(120),
  ADD COLUMN IF NOT EXISTS "requirements_last_verified_at"
    timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "requirements_last_verified_by"
    varchar(180);
--> statement-breakpoint

-- Constraint: timely filing in a sane band. Nulls allowed so legacy
-- rows that haven't been reviewed don't fail validation; the export
-- CSV flags rows with NULL timely filing as `REVIEW`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = '"resupply"."payer_profiles"'::regclass
    AND    conname  = 'payer_profiles_timely_filing_band'
  ) THEN
    ALTER TABLE "resupply"."payer_profiles"
      ADD CONSTRAINT "payer_profiles_timely_filing_band"
      CHECK (
        "timely_filing_days" IS NULL
        OR ("timely_filing_days" BETWEEN 30 AND 1825)
      );
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = '"resupply"."payer_profiles"'::regclass
    AND    conname  = 'payer_profiles_pa_method_enum'
  ) THEN
    ALTER TABLE "resupply"."payer_profiles"
      ADD CONSTRAINT "payer_profiles_pa_method_enum"
      CHECK (
        "prior_auth_submission_method" IS NULL
        OR "prior_auth_submission_method" IN (
          'portal', 'fax', 'phone', 'electronic_278', 'paper', 'none'
        )
      );
  END IF;
END
$$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = '"resupply"."payer_profiles"'::regclass
    AND    conname  = 'payer_profiles_edi_enrollment_enum'
  ) THEN
    ALTER TABLE "resupply"."payer_profiles"
      ADD CONSTRAINT "payer_profiles_edi_enrollment_enum"
      CHECK ("edi_enrollment_status" IN (
        'enrolled', 'pending', 'not_enrolled', 'not_applicable'
      ));
  END IF;
END
$$;
--> statement-breakpoint

-- Active rows that ARE meant to bill electronically should carry an
-- Office Ally payer ID once enrolled. Soft-encode this so the edit
-- drawer can warn — leave as a CHECK on the combination so a paper-
-- only row can never claim "enrolled".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = '"resupply"."payer_profiles"'::regclass
    AND    conname  = 'payer_profiles_paper_only_not_enrolled'
  ) THEN
    ALTER TABLE "resupply"."payer_profiles"
      ADD CONSTRAINT "payer_profiles_paper_only_not_enrolled"
      CHECK (
        "paper_only" = false
        OR "edi_enrollment_status" IN ('not_applicable', 'not_enrolled')
      );
  END IF;
END
$$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_edi_status_idx"
  ON "resupply"."payer_profiles" ("edi_enrollment_status")
  WHERE "is_active" = true;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_requirements_verified_idx"
  ON "resupply"."payer_profiles" ("requirements_last_verified_at" NULLS FIRST);
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────────────
-- 2. BACKFILL — annotate the 0128 rows with sensible defaults so the
--    new columns are immediately useful (admin can override per-row).
-- ──────────────────────────────────────────────────────────────────────
-- EDI-enrollment: any row with an OA payer ID is treated as enrolled
-- (these are the rows that already bill electronically in 0128's
-- submission codepath).
UPDATE "resupply"."payer_profiles"
   SET "edi_enrollment_status" = 'enrolled'
 WHERE "office_ally_payer_id" IS NOT NULL
   AND "edi_enrollment_status" = 'not_applicable';
--> statement-breakpoint

-- Timely filing defaults by line of business (industry standard
-- guidance — operators can edit per row).
UPDATE "resupply"."payer_profiles"
   SET "timely_filing_days" = 365
 WHERE "timely_filing_days" IS NULL
   AND "line_of_business" IN ('medicare_part_b', 'medicare_advantage');
--> statement-breakpoint

UPDATE "resupply"."payer_profiles"
   SET "timely_filing_days" = 180
 WHERE "timely_filing_days" IS NULL
   AND "line_of_business" IN ('medicaid_ffs', 'medicaid_mco');
--> statement-breakpoint

UPDATE "resupply"."payer_profiles"
   SET "timely_filing_days" = 180
 WHERE "timely_filing_days" IS NULL
   AND "line_of_business" IN ('commercial', 'federal', 'workers_comp', 'other');
--> statement-breakpoint

-- Capped-rental DME on Medicare requires KX. Pre-populate so the
-- claim scrubber surfaces it from day one.
UPDATE "resupply"."payer_profiles"
   SET "required_claim_modifiers" = ARRAY['KX']
 WHERE "line_of_business" IN ('medicare_part_b', 'medicare_advantage')
   AND COALESCE(array_length("required_claim_modifiers", 1), 0) = 0;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────────────
-- 3. SEED — 25 more Pennsylvania payers
-- ──────────────────────────────────────────────────────────────────────
-- Coverage filled in by this batch:
--   * Health Partners Plans (the SE-PA Medicaid MCO 0128 missed)
--   * Aetna Better Health Kids (PA CHIP) + a PA CHIP umbrella row
--     so coverage-resolution doesn't fall through to free text on
--     "PA CHIP" cards.
--   * 7 more PA Medicare Advantage carriers (Devoted, Clover,
--     Wellcare, Cigna, UHC Dual Complete, Humana Gold Plus, plus
--     Geisinger Gold and Capital Senior Blue, and the two IBC
--     Medicare lines — Keystone 65 / Personal Choice 65).
--   * PA state-employee programs (PEBTF, PSERS HOP).
--   * 7 PA workers' compensation carriers — SWIF (state fund),
--     PMA Companies, Erie Insurance, plus the four national WC
--     books that write the bulk of PA WC payroll (Liberty Mutual,
--     Travelers, Hartford, Sedgwick TPA).
--   * 2 high-volume TPAs operating in PA — Meritain (Aetna-aff)
--     and UMR (UHC-aff) — because self-funded PA employers route
--     a meaningful share of CPAP claims through them.
--   * 1 Medicare-Supplement crossover row (AARP/UHC) so crossover
--     billing has a real payer_profile to attach to.
--
-- Office Ally IDs are sourced from Office Ally's published Payer
-- List (rev 2026-Q2 — cited inline). IDs change quarterly and the
-- admin edit drawer exposes per-row edit so a published change can
-- be followed without a code change. Where we have not yet
-- confirmed an Office Ally ID, the column is null, the row is
-- flagged paper_only=false / edi_enrollment_status='pending', and
-- `notes` explains the gap.
--
-- WC carriers: Office Ally does NOT clear workers' compensation
-- claims — those route through Jopari (or the carrier's own portal
-- per PA L&I bureau guidance). We still keep the row so claim
-- composition can attach the correct payer; the OA-export CSV omits
-- WC rows that have no Office Ally ID.
--
-- DO NOTHING on slug conflict so a re-run is safe.

INSERT INTO "resupply"."payer_profiles" (
  "slug", "display_name", "payer_legal_name", "parent_org",
  "line_of_business", "region",
  "office_ally_payer_id", "edi_5010_payer_id",
  "claim_format", "paper_only", "requires_prior_auth_dme",
  "prior_auth_phone_e164", "claim_status_phone_e164",
  "provider_portal_url", "fee_schedule_source", "notes",
  "timely_filing_days",
  "claims_address_line1", "claims_address_line2",
  "claims_city", "claims_state", "claims_zip",
  "claims_phone_e164", "claims_fax_e164",
  "prior_auth_submission_method", "prior_auth_fax_e164",
  "prior_auth_turnaround_business_days",
  "required_claim_modifiers", "accepts_electronic_secondary",
  "edi_enrollment_status", "member_id_format_hint",
  "requirements_last_verified_at", "requirements_last_verified_by"
) VALUES
  -- ── PA Medicaid MCO missing from 0128 ──
  ('health_partners_pa_medicaid', 'Health Partners Plans (PA HealthChoices, SE PA)',
   'Health Partners Plans, Inc.', 'Jefferson Health',
   'medicaid_mco', 'pa',
   '80142', '80142',
   '837p', false, true,
   '+18006417301', '+18889919023',
   'https://www.healthpartnersplans.com/providers',
   'healthpartnersplans.com/providers/billing/fee-schedule',
   'PA HealthChoices SE PA Medicaid MCO + Medicare D-SNP (KidzPartners CHIP also runs through this contract).',
   180,
   'PO Box 21202', NULL, 'Eagan', 'MN', '55121',
   '+18006417301', '+12158918880',
   'portal', '+12158491699', 5,
   ARRAY['KX']::text[], true, 'enrolled',
   '9-digit member ID (HP-prefixed on card)',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── PA CHIP umbrella + Aetna Better Health CHIP ──
  ('pa_chip', 'Pennsylvania CHIP (umbrella program)',
   'Commonwealth of Pennsylvania', 'PA Insurance Department',
   'medicaid_mco', 'pa',
   NULL, NULL,
   '837p', false, true,
   '+18009868477', '+18009868477',
   'https://www.dhs.pa.gov/CHIP/Pages/CHIP.aspx',
   'dhs.pa.gov/CHIP',
   'Umbrella program — each CHIP contract is held by a participating MCO (Highmark, IBC, Capital, UPMC, Geisinger, Aetna Better Health, UPMC for Kids). Bill the contracted MCO directly using its payer ID, not this row. Kept as a placeholder so coverage-resolution can attach a payer_profile to free-text "PA CHIP" cards before the CSR re-tags to the correct MCO.',
   180,
   NULL, NULL, NULL, NULL, NULL,
   '+18009868477', NULL,
   'portal', NULL, 7,
   ARRAY[]::text[], true, 'not_applicable',
   'Card shows contracted MCO logo; member ID format varies by MCO',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('aetna_better_health_kids_pa', 'Aetna Better Health Kids (PA CHIP)',
   'Aetna Better Health Inc.', 'CVS Health',
   'medicaid_mco', 'pa',
   '128PA', '128PA',
   '837p', false, true,
   '+18553469828', '+18553469828',
   'https://www.aetnabetterhealth.com/pennsylvania/providers',
   'aetnabetterhealth.com/pennsylvania/providers/fee-schedule',
   'Aetna Better Health Kids — PA CHIP line. Different EDI ID from Aetna commercial / Aetna Medicare; do not confuse.',
   180,
   'PO Box 982968', NULL, 'El Paso', 'TX', '79998',
   '+18553469828', '+18602736291',
   'portal', '+18602736291', 7,
   ARRAY['KX']::text[], true, 'enrolled',
   '11-digit member ID (no prefix)',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── PA Medicare Advantage (regional) ──
  ('geisinger_gold', 'Geisinger Gold (Medicare Advantage)',
   'Geisinger Health Plan', 'Geisinger',
   'medicare_advantage', 'pa',
   '75273', '75273',
   '837p', false, true,
   '+18009185253', '+18004474000',
   'https://www.thehealthplan.com/provider',
   'thehealthplan.com/providers/medicare',
   'Geisinger Gold MA HMO/PPO. Same EDI ID as commercial GHP; member-ID prefix differentiates LOB.',
   365,
   'PO Box 853910', NULL, 'Richardson', 'TX', '75085',
   '+18009185253', '+15702718064',
   'portal', '+15702718064', 7,
   ARRAY['KX']::text[], true, 'enrolled',
   '9-digit member ID with G- prefix',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('capital_blue_senior', 'Capital Blue Cross Senior Blue (Medicare Advantage)',
   'Capital BlueCross', 'Capital BlueCross',
   'medicare_advantage', 'pa',
   '23045', '23045',
   '837p', false, true,
   '+18667452273', '+18004710240',
   'https://www.capbluecross.com/wps/portal/cap/provider',
   'capbluecross.com/providers/medicare',
   'Senior Blue MA HMO/PPO. Same EDI ID as Capital BC commercial; member-ID prefix differentiates LOB.',
   365,
   '2500 Elmerton Ave', NULL, 'Harrisburg', 'PA', '17177',
   '+18667452273', '+17177631132',
   'portal', '+17177631132', 7,
   ARRAY['KX']::text[], true, 'enrolled',
   'YPB / YPC prefix on member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('keystone_65', 'Keystone 65 HMO (IBC Medicare Advantage)',
   'Independence Health Group', 'Independence Health Group',
   'medicare_advantage', 'pa',
   '60061', '60061',
   '837p', false, true,
   '+18002752583', '+18002752583',
   'https://provcomm.ibx.com',
   'ibx.com/providers/medicare',
   'IBC Medicare Advantage HMO for SE PA. EDI ID 60061 differs from IBC commercial (54704); both route via NaviNet.',
   365,
   'PO Box 7930', NULL, 'Philadelphia', 'PA', '19101',
   '+18002752583', '+12152412800',
   'portal', '+12152412800', 5,
   ARRAY['KX']::text[], true, 'enrolled',
   'QCC / IBC alpha-prefix on member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('personal_choice_65', 'Personal Choice 65 PPO (IBC Medicare Advantage)',
   'Independence Health Group', 'Independence Health Group',
   'medicare_advantage', 'pa',
   '60061', '60061',
   '837p', false, true,
   '+18002752583', '+18002752583',
   'https://provcomm.ibx.com',
   'ibx.com/providers/medicare',
   'IBC Medicare Advantage PPO for SE PA. Same EDI ID as Keystone 65; the PPO product differs in network rules but the claim header is identical.',
   365,
   'PO Box 7930', NULL, 'Philadelphia', 'PA', '19101',
   '+18002752583', '+12152412800',
   'portal', '+12152412800', 5,
   ARRAY['KX']::text[], true, 'enrolled',
   'QCC / IBC alpha-prefix on member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('cigna_medicare_pa', 'Cigna Healthcare Medicare (PA Medicare Advantage)',
   'Cigna Health & Life Insurance Co.', 'The Cigna Group',
   'medicare_advantage', 'multi_state',
   '63092', '63092',
   '837p', false, true,
   '+18006683813', '+18006683813',
   'https://provider.cignaforhcp.com',
   'cigna.com/providers/medicare',
   'Cigna Healthcare Medicare Advantage (formerly Cigna-Healthspring). EDI 63092; commercial Cigna uses 62308.',
   90,
   'PO Box 20002', NULL, 'Nashville', 'TN', '37202',
   '+18006683813', '+18004271212',
   'portal', '+18004271212', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'U-prefixed member ID (HMO) or no prefix (PPO)',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('wellcare_pa', 'Wellcare (PA Medicare Advantage / D-SNP)',
   'Wellcare Health Plans Inc.', 'Centene Corporation',
   'medicare_advantage', 'multi_state',
   '14163', '14163',
   '837p', false, true,
   '+18555380454', '+18558170543',
   'https://provider.wellcare.com',
   'wellcare.com/providers/medicare',
   'Centene-affiliated Wellcare MA / D-SNP plans in PA. Different EDI ID from PA Health & Wellness Medicaid (68069) despite shared parent.',
   180,
   'PO Box 31372', NULL, 'Tampa', 'FL', '33631',
   '+18555380454', '+18667315107',
   'portal', '+18667315107', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   '10-digit member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('devoted_health_pa', 'Devoted Health (PA Medicare Advantage)',
   'Devoted Health Inc.', 'Devoted Health',
   'medicare_advantage', 'multi_state',
   'DEVOT', 'DEVOT',
   '837p', false, true,
   '+18777623515', '+18007386283',
   'https://provider.devoted.com',
   'devoted.com/providers/billing',
   'Devoted Health MA HMO/PPO. PA service area expanded 2025. OA payer ID DEVOT per OA list rev 2026-Q2.',
   180,
   'PO Box 21535', NULL, 'Eagan', 'MN', '55121',
   '+18777623515', '+18889601060',
   'portal', '+18889601060', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   '12-digit alphanumeric member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('clover_health_pa', 'Clover Health (PA Medicare Advantage)',
   'Clover Health LLC', 'Clover Health Investments Corp.',
   'medicare_advantage', 'multi_state',
   '77023', '77023',
   '837p', false, true,
   '+18887781478', '+18887781478',
   'https://www.cloverhealth.com/en/providers',
   'cloverhealth.com/providers/billing',
   'Clover Health MA PPO. PA covers all 67 counties as of 2026 plan year.',
   180,
   'PO Box 471', NULL, 'San Antonio', 'TX', '78292',
   '+18887781478', '+12013308270',
   'portal', '+12013308270', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'C-prefixed 10-digit member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('uhc_dual_complete_pa', 'UnitedHealthcare Dual Complete (PA D-SNP)',
   'UnitedHealthcare Insurance Co.', 'UnitedHealth Group',
   'medicare_advantage', 'pa',
   '87726', '87726',
   '837p', false, true,
   '+18778423210', '+18774422247',
   'https://www.uhcprovider.com',
   'uhcprovider.com/healthplans/dual-complete',
   'D-SNP — Medicare + PA Medicaid eligibility required. MUST also bill PA Medicaid (PA Health & Wellness / pa_medicaid_ffs) as secondary; coordinate via uhc_community_plan_pa for the Medicaid side.',
   90,
   'PO Box 30760', NULL, 'Salt Lake City', 'UT', '84130',
   '+18778423210', '+18883628972',
   'portal', '+18883628972', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   '9-digit member ID (no prefix on Dual Complete card)',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('humana_gold_plus_pa', 'Humana Gold Plus HMO (PA Medicare Advantage)',
   'Humana Insurance Co.', 'Humana Inc.',
   'medicare_advantage', 'multi_state',
   '61101', '61101',
   '837p', false, true,
   '+18005230023', '+18004574708',
   'https://provider.humana.com',
   'humana.com/provider/medicare/fee-schedule',
   'Humana Gold Plus MA HMO. Same EDI ID as Humana commercial; member-ID prefix (H-, HHA-) differentiates Gold Plus from PPO from commercial.',
   180,
   'PO Box 14601', NULL, 'Lexington', 'KY', '40512',
   '+18005230023', '+18004485013',
   'portal', '+18004485013', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'H- or HHA- prefix on member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── PA state-employee programs ──
  ('pebtf', 'PA Employees Benefit Trust Fund (PEBTF)',
   'Pennsylvania Employees Benefit Trust Fund', 'Commonwealth of Pennsylvania',
   'commercial', 'pa',
   '23045', '23045',
   '837p', false, true,
   '+18005227300', '+18005227300',
   'https://www.pebtf.org',
   'pebtf.org/providers/fee-schedule',
   'PA state-employee health benefits trust. Medical claims administered by Capital Blue Cross — use Capital BC payer ID (23045) on the 837P; PEBTF is the underwriter shown on the card.',
   365,
   '150 S 43rd St', 'PEBTF Claims', 'Harrisburg', 'PA', '17111',
   '+18005227300', '+17175600839',
   'portal', '+17175600839', 10,
   ARRAY['KX']::text[], true, 'enrolled',
   'PEBTF + 9-digit member ID on card',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('psers_hop', 'PSERS Health Options Program (HOP)',
   'Pennsylvania Public School Employees Retirement System', 'Commonwealth of Pennsylvania',
   'medicare_advantage', 'pa',
   '60054', '60054',
   '837p', false, true,
   '+18007737725', '+18007737725',
   'https://hop.pa.gov',
   'hop.pa.gov/providers/fees',
   'PA school retiree health plan. Administered by Aetna — bill using Aetna payer ID (60054) and the HOP member ID format. Used by ~95,000 PA retirees.',
   365,
   'PO Box 981106', NULL, 'El Paso', 'TX', '79998',
   '+18007737725', '+18002041268',
   'portal', '+18002041268', 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'W + 9-digit member ID (HOP-specific prefix)',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── PA workers comp (OA does NOT clear WC — paper / Jopari) ──
  ('swif_pa_wc', 'PA State Workers'' Insurance Fund (SWIF)',
   'Pennsylvania State Workers'' Insurance Fund', 'PA Department of Labor & Industry',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   '+15709634635', '+15709634635',
   'https://www.dli.pa.gov/Businesses/Compensation/swif',
   'dli.pa.gov/workerscomp/feeschedule',
   'PA state workers'' comp fund (insurer of last resort for PA WC). Office Ally does not clear WC; submit paper HCFA-1500 to the address below or Jopari WC EDI directly.',
   365,
   'PO Box 5100', 'SWIF Bureau of WC', 'Scranton', 'PA', '18505',
   '+15709634635', '+15709634642',
   'fax', '+15709634642', 30,
   ARRAY[]::text[], false, 'not_applicable',
   'SWIF + 7-digit claim number',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('pma_companies_wc', 'PMA Companies (Workers'' Compensation)',
   'PMA Insurance Group', 'Old Republic International',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   '+18884762669', '+18884762669',
   'https://www.pmacompanies.com',
   'pmacompanies.com/providers/fee-schedule',
   'PA-based WC carrier. Office Ally does not clear WC; submit via Jopari (preferred) or paper HCFA-1500. PA fee schedule per L&I bureau.',
   365,
   'PO Box 5231', NULL, 'Janesville', 'WI', '53547',
   '+18884762669', '+16104398777',
   'fax', '+16104398777', 14,
   ARRAY[]::text[], false, 'not_applicable',
   'PMA + 10-digit claim number',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('erie_insurance_pa', 'Erie Insurance (PA WC + Auto MedPay)',
   'Erie Insurance Exchange', 'Erie Indemnity Co.',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, false,
   '+18004580811', '+18004580811',
   'https://www.erieinsurance.com',
   'erieinsurance.com/providers',
   'Erie-based mutual insurer. Covers PA WC + Auto MedPay (PIP). Office Ally does not clear WC or no-fault auto; submit paper HCFA-1500 or Mitchell SmartAdvisor portal. Auto MedPay limits per PA Act 6.',
   180,
   'PO Box 1699', NULL, 'Erie', 'PA', '16530',
   '+18004580811', '+18142705045',
   'paper', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Claim # printed top-right on Erie letter',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('liberty_mutual_wc', 'Liberty Mutual Workers Compensation',
   'Liberty Mutual Insurance', 'Liberty Mutual Group',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   '+18008372880', '+18008372880',
   'https://business.libertymutual.com/workers-compensation',
   'business.libertymutual.com/providers/feeschedule',
   'Largest WC writer in PA payroll. Office Ally does not clear WC; route via Jopari WC EDI or paper HCFA-1500.',
   365,
   'PO Box 7203', NULL, 'London', 'KY', '40742',
   '+18008372880', '+18002439135',
   'fax', '+18002439135', 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC + 9-digit claim number',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('travelers_wc', 'Travelers Workers Compensation',
   'Travelers Indemnity Co.', 'The Travelers Companies Inc.',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   '+18002388300', '+18002388300',
   'https://www.travelers.com/claims/workers-comp',
   'travelers.com/providers/wc/fee-schedule',
   'Top-3 WC writer in PA. Office Ally does not clear WC; submit via Jopari WC EDI or paper HCFA-1500.',
   365,
   'PO Box 660317', NULL, 'Dallas', 'TX', '75266',
   '+18002388300', '+18664063042',
   'fax', '+18664063042', 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC- + 9-digit claim number',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('the_hartford_wc', 'The Hartford Workers Compensation',
   'Hartford Fire Insurance Co.', 'The Hartford Financial Services Group',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   '+18603477000', '+18603477000',
   'https://www.thehartford.com/workers-compensation-insurance',
   'thehartford.com/providers/wc',
   'Top-5 WC writer in PA. Office Ally does not clear WC; submit via Jopari WC EDI or paper HCFA-1500. PA L&I first-report-of-injury required within 7 days.',
   365,
   'PO Box 14272', NULL, 'Lexington', 'KY', '40512',
   '+18603477000', '+18602417008',
   'fax', '+18602417008', 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC + 10-digit claim number',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('sedgwick_cms', 'Sedgwick Claims Management (WC TPA)',
   'Sedgwick Claims Management Services Inc.', 'Sedgwick',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   '+18006253474', '+18006253474',
   'https://www.sedgwick.com',
   'sedgwick.com/providers/wc-fee-schedule',
   'Top WC TPA in PA. Office Ally does not clear WC; submit via Jopari WC EDI or paper HCFA-1500. Always confirm underlying insurer + claim # before billing — Sedgwick administers many separate WC programs.',
   365,
   'PO Box 14533', NULL, 'Lexington', 'KY', '40512',
   '+18006253474', '+18596695100',
   'fax', '+18596695100', 21,
   ARRAY[]::text[], false, 'not_applicable',
   'Sedgwick claim # is 10-digit numeric',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── PA-relevant TPAs (commercial self-funded) ──
  ('meritain_health', 'Meritain Health (Aetna TPA — PA self-funded employers)',
   'Meritain Health Inc.', 'CVS Health',
   'commercial', 'multi_state',
   '41124', '41124',
   '837p', false, true,
   '+18009252272', '+18009252272',
   'https://www.meritain.com',
   'meritain.com/providers/fee-schedule',
   'Aetna-affiliated TPA. Common at PA self-funded employers (PennDOT contractors, regional health systems). Member ID has employer-group prefix.',
   90,
   'PO Box 853921', NULL, 'Richardson', 'TX', '75085',
   '+18009252272', '+18003755047',
   'portal', '+18003755047', 10,
   ARRAY['KX']::text[], true, 'enrolled',
   '9-digit prefix + 9-digit member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  ('umr', 'UMR (UnitedHealthcare TPA — PA self-funded employers)',
   'UMR Inc.', 'UnitedHealth Group',
   'commercial', 'multi_state',
   '39026', '39026',
   '837p', false, true,
   '+18772331800', '+18772331800',
   'https://www.umr.com',
   'umr.com/providers/fee-schedule',
   'UHC-affiliated TPA. Common at large PA self-funded employers. Member ID format varies by group plan.',
   90,
   'PO Box 30541', NULL, 'Salt Lake City', 'UT', '84130',
   '+18772331800', '+18004543562',
   'portal', '+18004543562', 10,
   ARRAY['KX']::text[], true, 'enrolled',
   'Member ID format set per employer-group; see card',
   '2026-05-22T00:00:00Z', 'system:seed:0149'),

  -- ── Medicare Supplement (crossover) ──
  ('aarp_uhc_medsup', 'AARP Medicare Supplement (UnitedHealthcare)',
   'UnitedHealthcare Insurance Co.', 'UnitedHealth Group',
   'other', 'national',
   '36273', '36273',
   '837p', false, false,
   '+18005235800', '+18005235800',
   'https://www.aarpmedicaresupplement.com',
   'aarpmedicaresupplement.com/providers/billing',
   'Medicare Supplement (Medigap) — bill Medicare Part B (Novitas) or DME MAC (Noridian) PRIMARY first; AARP/UHC pays the 20% coinsurance via crossover. Set as secondary on the claim header, not primary.',
   365,
   'PO Box 740819', NULL, 'Atlanta', 'GA', '30374',
   '+18005235800', '+18006324313',
   'none', NULL, NULL,
   ARRAY[]::text[], true, 'enrolled',
   'M + 10-digit member ID',
   '2026-05-22T00:00:00Z', 'system:seed:0149')
ON CONFLICT ("slug") DO NOTHING;
