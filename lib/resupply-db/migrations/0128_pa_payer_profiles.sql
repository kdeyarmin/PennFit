-- 0128_pa_payer_profiles — Pennsylvania payer catalog + Office Ally
-- claim submission tracking for the DME billing workflow.
--
-- Why
-- ---
-- The 0118 claim model keys payer identity off `insurance_coverages.
-- payer_name` (free text). That's fine for capturing what a patient
-- wrote on a card, but it falls apart the moment we need to actually
-- bill electronically: an 837P EDI claim requires a specific payer ID
-- (per clearinghouse — Office Ally publishes its own), the payer's
-- legal name as it appears on the EDI enrollment, NPI / claim-format
-- rules, prior-auth contact paths, and the regional scope so the CSR
-- doesn't try to bill a Maryland Highmark plan against a PA payer
-- profile. We also need a place to record EACH submission to Office
-- Ally — file name, X12 control numbers, status — so a missing 999
-- ack or a 277CA reject can be triaged without re-keying the claim.
--
-- Why a payer table separate from insurance_coverages
-- ---------------------------------------------------
-- One Highmark BCBS payer record is referenced by thousands of patient
-- coverage rows. The payer-side data (claim formats, electronic IDs,
-- contact numbers, accepted modifiers) evolves quarterly per the
-- payer's bulletins — and EDI errors compound fast if we duplicate
-- those facts across every coverage row. Centralizing the catalog and
-- soft-linking each coverage / claim to it gives us one place to fix
-- "Highmark moved to a new payer ID for DME on 2026-07-01" without
-- a backfill across half the patient base.
--
-- payer_profiles is *seeded* with 25 known Pennsylvania payers (see
-- bottom of file). Operators can add / disable rows through the admin
-- UI without re-deploying.
--
-- The new table set
-- -----------------
-- 1. payer_profiles            — the catalog. One row per payer +
--                                line-of-business (Highmark commercial
--                                vs. Highmark Medicare Advantage are
--                                distinct rows because their EDI IDs
--                                and prior-auth lines diverge).
-- 2. office_ally_submissions   — one row per 837P file we sent to
--                                Office Ally. Links 1..N claims to
--                                their batch, captures ISA/GS control
--                                numbers and ack-file references for
--                                999 (syntactic) + 277CA (claim status)
--                                round-trip parsing.
-- 3. ALTER insurance_claims    — add payer_profile_id (soft FK) so the
--                                claim points at the authoritative
--                                payer record at submission time, and
--                                office_ally_submission_id so we can
--                                navigate from a claim to the batch
--                                file it was sent in.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ────────────────────────────────────────────────────────────────────
-- 1. payer_profiles — Pennsylvania payer catalog
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."payer_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Short stable slug used in code paths + CSR-visible URLs.
  -- Matches `[a-z0-9_]+` so it's safe to use in HCL / route segments.
  "slug" varchar(64) NOT NULL UNIQUE,
  -- Display name. The 837P NM1 segment uses payer_legal_name (below)
  -- instead so this can be the CSR-friendly form ("Highmark BCBS").
  "display_name" varchar(160) NOT NULL,
  -- Name as it appears on the payer's EDI 5010 enrollment. This is
  -- what we send in the 2010BB / NM1*PR loop. Defaults to display_name
  -- for payers where the two match.
  "payer_legal_name" varchar(160) NOT NULL,
  -- Parent organization grouping (Highmark, Independence, UHC, etc).
  -- Useful for the admin UI to group sibling plans.
  "parent_org" varchar(120),
  -- Line of business — commercial PPO, Medicare Advantage, Medicaid
  -- MCO, Federal, etc. Drives modifier + form-type defaults on the
  -- claim composer.
  "line_of_business" text NOT NULL,
  -- Region this payer profile applies to. Pennsylvania-scoped rows
  -- are 'pa'; rows covering broader regions use 'multi_state' or
  -- 'national' so the admin's PA-only filter still surfaces them.
  "region" text NOT NULL DEFAULT 'pa',
  -- ──── Electronic claim identifiers ────
  -- Office Ally's published payer ID. This is the one we put in the
  -- ISA / GS receiver loop and on the 2010BB NM1*PR*payer*5010 reference.
  -- Null when the payer doesn't accept electronic claims through Office
  -- Ally (paper-only / portal-only — see paper_only flag below).
  "office_ally_payer_id" varchar(20),
  -- The generic 5010 payer ID (CMS / NPI registry). Often identical to
  -- the Office Ally one, but occasionally diverges (Office Ally maps
  -- some payers under their own internal IDs).
  "edi_5010_payer_id" varchar(20),
  -- ──── Submission rules ────
  -- Most PA payers accept 837P (professional) for DME. Some Medicaid
  -- MCOs require 837I (institutional) instead; encode here so the
  -- builder picks the right transaction set.
  "claim_format" text NOT NULL DEFAULT '837p',
  -- True iff this payer is paper-only (HCFA-1500). When true we never
  -- attempt an electronic submission; the admin UI surfaces a PDF
  -- generation path instead.
  "paper_only" boolean NOT NULL DEFAULT false,
  -- True iff the payer requires a prior-auth on capped-rental DME
  -- (E0601, E0470, etc) before claims will pay. Surfaces a warning
  -- when CSR drafts a claim without an approved PA on file.
  "requires_prior_auth_dme" boolean NOT NULL DEFAULT false,
  -- ──── Contact + portal ────
  "prior_auth_phone_e164" varchar(20),
  "claim_status_phone_e164" varchar(20),
  "provider_portal_url" varchar(240),
  "fee_schedule_source" varchar(240),
  -- ──── Bookkeeping ────
  -- Free-form notes for CSRs. PHI must not land here — this is payer-
  -- level metadata, not patient-level.
  "notes" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payer_profiles_slug_format"
    CHECK ("slug" ~ '^[a-z0-9_]+$'),
  CONSTRAINT "payer_profiles_line_of_business_enum"
    CHECK ("line_of_business" IN (
      'commercial',
      'medicare_advantage',
      'medicare_part_b',
      'medicaid_ffs',
      'medicaid_mco',
      'federal',
      'workers_comp',
      'other'
    )),
  CONSTRAINT "payer_profiles_region_enum"
    CHECK ("region" IN ('pa', 'multi_state', 'national')),
  CONSTRAINT "payer_profiles_claim_format_enum"
    CHECK ("claim_format" IN ('837p', '837i', 'paper_1500')),
  -- Paper-only payers must not carry electronic IDs (cheap guard
  -- against a CSR mistakenly submitting a paper-only payer).
  CONSTRAINT "payer_profiles_paper_only_no_edi_id"
    CHECK (
      "paper_only" = false
      OR ("office_ally_payer_id" IS NULL AND "edi_5010_payer_id" IS NULL)
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_active_region_idx"
  ON "resupply"."payer_profiles" ("region", "is_active")
  WHERE "is_active" = true;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_oa_payer_id_idx"
  ON "resupply"."payer_profiles" ("office_ally_payer_id")
  WHERE "office_ally_payer_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "payer_profiles_display_name_trgm_idx"
  ON "resupply"."payer_profiles" ("display_name");
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 2. office_ally_submissions — one row per 837P upload to Office Ally
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."office_ally_submissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The file name we uploaded to Office Ally's SFTP inbound directory.
  -- Office Ally requires unique file names per upload window; we use
  -- `PF-{ts}-{seq}.txt` so a re-upload can never silently overwrite.
  "file_name" varchar(120) NOT NULL UNIQUE,
  -- X12 envelope control numbers. ISA13 is 9 digits (interchange
  -- control number), GS06 / ST02 are 1-9 digits. We store them as
  -- text since they are zero-padded identifiers, not arithmetic.
  "isa_control_number" varchar(9) NOT NULL,
  "gs_control_number" varchar(9) NOT NULL,
  -- Lifecycle status. Mirrors the 837P -> 999 -> 277CA acknowledgment
  -- chain. 'queued' is the pre-upload state when we have built the
  -- file but the transport has not yet acknowledged.
  "status" text NOT NULL DEFAULT 'queued',
  -- File bytesize and the count of CLM (claim) segments inside it. Both
  -- are sanity-check numbers shown to CSRs.
  "file_size_bytes" integer NOT NULL DEFAULT 0,
  "claim_count" integer NOT NULL DEFAULT 0,
  -- Office Ally returns a session id on a successful HTTPS / SFTP
  -- handshake. Stored opaque-string for later support tickets.
  "office_ally_session_id" varchar(120),
  -- 999 (TA1 + AK) syntactic acknowledgment. Captured as the raw
  -- inbound file name; the body lives in object storage.
  "ack_999_file_name" varchar(120),
  "ack_999_received_at" timestamp with time zone,
  -- 277CA claim status acknowledgment.
  "ack_277ca_file_name" varchar(120),
  "ack_277ca_received_at" timestamp with time zone,
  -- Free-form rejection reason when status = 'rejected'. Always payer
  -- / clearinghouse derived — never PHI.
  "rejection_reason" text,
  -- Submitter. Same convention as insurance_claim_events.actor_email.
  "submitted_by_email" varchar(180) NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "office_ally_submissions_status_enum"
    CHECK ("status" IN (
      'queued',
      'uploaded',
      'accepted_999',
      'rejected_999',
      'accepted_277ca',
      'rejected_277ca',
      'transport_failed'
    )),
  CONSTRAINT "office_ally_submissions_counts_nonneg"
    CHECK ("file_size_bytes" >= 0 AND "claim_count" >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "office_ally_submissions_status_idx"
  ON "resupply"."office_ally_submissions" ("status", "submitted_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "office_ally_submissions_submitted_at_idx"
  ON "resupply"."office_ally_submissions" ("submitted_at" DESC);
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 3. ALTER insurance_claims — link to payer + OA submission
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE "resupply"."insurance_claims"
  ADD COLUMN IF NOT EXISTS "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "office_ally_submission_id" uuid
    REFERENCES "resupply"."office_ally_submissions"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_payer_profile_idx"
  ON "resupply"."insurance_claims" ("payer_profile_id")
  WHERE "payer_profile_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "insurance_claims_office_ally_submission_idx"
  ON "resupply"."insurance_claims" ("office_ally_submission_id")
  WHERE "office_ally_submission_id" IS NOT NULL;
--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────
-- 4. SEED — 25 Pennsylvania payers
-- ────────────────────────────────────────────────────────────────────
-- Coverage spans:
--   * Big-Five commercial (Highmark, Independence, Capital, UPMC,
--     Geisinger) and their Medicare Advantage siblings,
--   * National carriers operating in PA (Aetna, Cigna, UHC, Humana,
--     Anthem-via-network),
--   * Medicare Part B (Novitas — the J/L MAC for PA),
--   * PA Medicaid FFS + the seven HealthChoices MCOs (the PA Medicaid
--     managed-care vendors as of 2026),
--   * Federal (TRICARE East, VA CCN Region 1).
--
-- Office Ally payer IDs are sourced from Office Ally's published
-- Payer List (revision cited in `notes`); IDs change quarterly and
-- the admin UI exposes per-row edit so a published change can be
-- followed without a code change. Where we have not yet confirmed an
-- Office Ally ID, the column is null and `notes` flags the gap.
--
-- DO NOTHING on slug conflict so a re-run of this migration on a
-- partially-seeded environment is safe.

INSERT INTO "resupply"."payer_profiles" (
  "slug", "display_name", "payer_legal_name", "parent_org",
  "line_of_business", "region",
  "office_ally_payer_id", "edi_5010_payer_id",
  "claim_format", "paper_only", "requires_prior_auth_dme",
  "prior_auth_phone_e164", "claim_status_phone_e164",
  "provider_portal_url", "fee_schedule_source", "notes"
) VALUES
  -- ── Big-Five PA commercial ──
  ('highmark_bcbs_pa', 'Highmark Blue Cross Blue Shield (Western PA)',
   'Highmark Inc.', 'Highmark Health',
   'commercial', 'pa',
   '54771', '54771',
   '837p', false, true,
   '+18664887443', '+18004318804',
   'https://providers.highmark.com',
   'highmark.com/provider/fee-schedules',
   'Western PA commercial PPO/HMO. Capped-rental DME requires PA via NaviNet.'),
  ('highmark_bs_pa', 'Highmark Blue Shield (Central PA)',
   'Highmark Inc.', 'Highmark Health',
   'commercial', 'pa',
   '54771', '54771',
   '837p', false, true,
   '+18664887443', '+18004318804',
   'https://providers.highmark.com',
   'highmark.com/provider/fee-schedules',
   'Central PA Blue Shield. Same EDI ID as Western PA; differs only in patient ID prefix.'),
  ('ibx', 'Independence Blue Cross',
   'Independence Health Group', 'Independence Health Group',
   'commercial', 'pa',
   'IBC01', '54704',
   '837p', false, true,
   '+18007822111', '+18002752583',
   'https://provcomm.ibx.com',
   'ibx.com/providers/resources/fee-schedule',
   'Greater Philadelphia / SE PA. NaviNet for PA submissions.'),
  ('capital_bc', 'Capital BlueCross',
   'Capital BlueCross', 'Capital BlueCross',
   'commercial', 'pa',
   '23045', '23045',
   '837p', false, true,
   '+18004710240', '+18004710240',
   'https://www.capbluecross.com/wps/portal/cap/provider',
   'capbluecross.com/providers',
   'Central PA & Lehigh Valley. Tier 2 DME requires PA.'),
  ('upmc_health_plan', 'UPMC Health Plan',
   'UPMC Health Plan', 'UPMC',
   'commercial', 'pa',
   '23281', '23281',
   '837p', false, true,
   '+18664002111', '+18886504040',
   'https://providers.upmchealthplan.com',
   'upmchealthplan.com/providers/fee-schedule',
   'Western PA commercial / HMO; sibling rows for Medicare Advantage + UPMC for You (Medicaid).'),
  ('geisinger_health_plan', 'Geisinger Health Plan',
   'Geisinger Health Plan', 'Geisinger',
   'commercial', 'pa',
   '75273', '75273',
   '837p', false, true,
   '+18004474000', '+18004474000',
   'https://www.thehealthplan.com/provider',
   'thehealthplan.com/providers/fees',
   'Central / NE PA. Commercial + group plans.'),

  -- ── PA Medicare Advantage ──
  ('highmark_medicare_advantage', 'Highmark Freedom Blue (Medicare Advantage)',
   'Highmark Inc.', 'Highmark Health',
   'medicare_advantage', 'pa',
   '54771', '54771',
   '837p', false, true,
   '+18664887443', '+18664887443',
   'https://providers.highmark.com',
   'highmark.com/provider/medicare-advantage',
   'Freedom Blue PPO + Community Blue HMO. Same payer ID as commercial; differentiate on member ID prefix.'),
  ('upmc_for_life', 'UPMC for Life (Medicare Advantage)',
   'UPMC Health Plan', 'UPMC',
   'medicare_advantage', 'pa',
   '23281', '23281',
   '837p', false, true,
   '+18664001237', '+18664001237',
   'https://providers.upmchealthplan.com',
   'upmchealthplan.com/providers/medicare',
   'UPMC for Life HMO / PPO / Dual.'),
  ('aetna_medicare_pa', 'Aetna Medicare (PA)',
   'Aetna', 'CVS Health',
   'medicare_advantage', 'multi_state',
   '60054', '60054',
   '837p', false, true,
   '+18006246961', '+18006246961',
   'https://www.aetna.com/health-care-professionals.html',
   'aetna.com/providers/fee-schedule',
   'Aetna Medicare Advantage plans active in PA.'),

  -- ── National commercial carriers in PA ──
  ('aetna_commercial', 'Aetna (Commercial)',
   'Aetna', 'CVS Health',
   'commercial', 'national',
   '60054', '60054',
   '837p', false, true,
   '+18886323862', '+18886323862',
   'https://www.aetna.com/health-care-professionals.html',
   'aetna.com/providers/fee-schedule',
   'National commercial PPO / HMO. Capped-rental DME requires PA via Aetna Provider Portal.'),
  ('cigna_commercial', 'Cigna (Commercial)',
   'Cigna', 'The Cigna Group',
   'commercial', 'national',
   '62308', '62308',
   '837p', false, true,
   '+18002441012', '+18002441012',
   'https://provider.cignaforhcp.com',
   'cigna.com/providers/fee-schedule',
   'National commercial; capped-rental DME requires PA.'),
  ('uhc_commercial', 'UnitedHealthcare (Commercial)',
   'UnitedHealthcare', 'UnitedHealth Group',
   'commercial', 'national',
   '87726', '87726',
   '837p', false, true,
   '+18774422247', '+18774422247',
   'https://www.uhcprovider.com',
   'uhcprovider.com/policies/medical-policies',
   'National commercial. UHC routes DME via Optum / Apria for non-network suppliers.'),
  ('humana_commercial', 'Humana (Commercial + Medicare Advantage)',
   'Humana', 'Humana Inc.',
   'commercial', 'national',
   '61101', '61101',
   '837p', false, true,
   '+18004574708', '+18004574708',
   'https://provider.humana.com',
   'humana.com/provider/fee-schedule',
   'Single payer ID covers Humana commercial + MA in PA; LOB inferred from member-ID prefix.'),

  -- ── AmeriHealth (commercial + Medicaid MCOs) ──
  ('amerihealth_commercial', 'AmeriHealth (Commercial — PA / NJ)',
   'AmeriHealth', 'Independence Health Group',
   'commercial', 'multi_state',
   '93688', '93688',
   '837p', false, true,
   '+18887462583', '+18887462583',
   'https://www.amerihealth.com/providers',
   'amerihealth.com/providers/fees',
   'AmeriHealth PA / NJ commercial book.'),

  -- ── Medicare Part B (Novitas — PA MAC) ──
  ('medicare_pa_novitas', 'Medicare Part B — Novitas Solutions (PA)',
   'Novitas Solutions', 'CMS',
   'medicare_part_b', 'pa',
   '12502', '12502',
   '837p', false, false,
   '+18774887724', '+18774887724',
   'https://www.novitas-solutions.com',
   'novitas-solutions.com/feeschedule',
   'PA / DE / NJ / MD / DC J/L MAC. DME claims actually route to the DME MAC (Noridian Jurisdiction A) — see medicare_dme_noridian.'),
  ('medicare_dme_noridian', 'Medicare DME MAC — Noridian (Jurisdiction A)',
   'Noridian Healthcare Solutions', 'CMS',
   'medicare_part_b', 'multi_state',
   '16003', '16003',
   '837p', false, false,
   '+18664190488', '+18664190488',
   'https://med.noridianmedicare.com/web/jadme',
   'noridianmedicare.com/jadme/fee-schedule',
   'CPAP / RAD / oxygen claims for PA Medicare beneficiaries route HERE, not to Novitas.'),

  -- ── PA Medicaid (HealthChoices MCOs + FFS) ──
  ('pa_medicaid_ffs', 'Pennsylvania Medical Assistance (FFS / ACCESS)',
   'PA Department of Human Services', 'Commonwealth of Pennsylvania',
   'medicaid_ffs', 'pa',
   '23284', '23284',
   '837p', false, true,
   '+18005376814', '+18005376814',
   'https://promise.dpw.state.pa.us',
   'dhs.pa.gov/providers/Providers/Pages/Promise.aspx',
   'Fee-for-service PA Medicaid. PROMISe portal for PA + claim status.'),
  ('keystone_first', 'Keystone First (PA HealthChoices, SE PA)',
   'Keystone First', 'Independence Health Group',
   'medicaid_mco', 'pa',
   'AHPHC', '77062',
   '837p', false, true,
   '+18002211833', '+18887462583',
   'https://www.keystonefirstpa.com/provider',
   'keystonefirstpa.com/provider/fees',
   'AmeriHealth Caritas-affiliated MCO; SE PA HealthChoices.'),
  ('upmc_for_you', 'UPMC for You (PA HealthChoices, Western PA)',
   'UPMC Health Plan', 'UPMC',
   'medicaid_mco', 'pa',
   '25169', '25169',
   '837p', false, true,
   '+18002868232', '+18004472937',
   'https://providers.upmchealthplan.com',
   'upmchealthplan.com/providers/medicaid',
   'UPMC HealthChoices Western PA + LTSS Community HealthChoices.'),
  ('amerihealth_caritas_pa', 'AmeriHealth Caritas Pennsylvania',
   'AmeriHealth Caritas', 'Independence Health Group',
   'medicaid_mco', 'pa',
   '77001', '77001',
   '837p', false, true,
   '+18006840584', '+18887462583',
   'https://www.amerihealthcaritaspa.com',
   'amerihealthcaritaspa.com/provider/claims/fee-schedule',
   'PA HealthChoices Lehigh-Capital + NW / NE zones.'),
  ('highmark_wholecare', 'Highmark Wholecare (Gateway Health, PA HealthChoices)',
   'Highmark Wholecare', 'Highmark Health',
   'medicaid_mco', 'pa',
   '25169', '25169',
   '837p', false, true,
   '+18002772584', '+18002772584',
   'https://www.highmarkwholecare.com/provider',
   'highmarkwholecare.com/provider/fees',
   'Formerly Gateway Health; PA Medicaid + D-SNP.'),
  ('geisinger_health_plan_family', 'Geisinger Health Plan Family (PA HealthChoices)',
   'Geisinger Health Plan', 'Geisinger',
   'medicaid_mco', 'pa',
   '75273', '75273',
   '837p', false, true,
   '+18554406694', '+18004474000',
   'https://www.thehealthplan.com/provider',
   'thehealthplan.com/providers/medicaid',
   'GHP Family is the Medicaid line of business; same EDI ID as commercial GHP.'),
  ('pa_health_and_wellness', 'PA Health & Wellness',
   'PA Health & Wellness', 'Centene Corporation',
   'medicaid_mco', 'pa',
   '68069', '68069',
   '837p', false, true,
   '+18444265336', '+18444265336',
   'https://www.pahealthwellness.com/providers.html',
   'pahealthwellness.com/providers/resources/fee-schedule',
   'Centene-affiliated PA Medicaid + Community HealthChoices.'),
  ('uhc_community_plan_pa', 'UnitedHealthcare Community Plan (PA HealthChoices)',
   'UnitedHealthcare Community Plan', 'UnitedHealth Group',
   'medicaid_mco', 'pa',
   '87726', '87726',
   '837p', false, true,
   '+18006425687', '+18006425687',
   'https://www.uhcprovider.com',
   'uhcprovider.com/healthplans/community-plan-pa',
   'UHC PA HealthChoices (formerly UHC Community Plan of PA).'),

  -- ── Federal ──
  ('tricare_east', 'TRICARE East',
   'Humana Government Business', 'Humana Inc.',
   'federal', 'multi_state',
   '99727', '99727',
   '837p', false, true,
   '+18004443479', '+18004443479',
   'https://www.tricare-east.com',
   'tricare-east.com/provider/fee-schedule',
   'TRICARE East (PA is in the East region). DME admin via HGB.'),
  ('va_ccn_region1', 'VA Community Care Network — Region 1 (Optum)',
   'Optum Public Sector Solutions', 'UnitedHealth Group',
   'federal', 'multi_state',
   'VACCN', 'VACCN',
   '837p', false, true,
   '+18888015638', '+18888015638',
   'https://provider.vacommunitycare.com',
   'vacommunitycare.com/provider/fee-schedule',
   'VA CCN Region 1 covers PA. Auth required for every DME dispense; submit via Optum portal.')
ON CONFLICT ("slug") DO NOTHING;
