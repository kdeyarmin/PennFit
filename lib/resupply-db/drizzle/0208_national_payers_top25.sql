-- 0208_national_payers_top25 — round the catalog out to the top national
-- health insurers AVAILABLE IN PENNSYLVANIA.
--
-- Why
-- ---
-- The catalog (0128 + 0149) already carries the big national carriers a PA
-- DME supplier bills every day — UnitedHealthcare, Aetna/CVS, Cigna, Humana,
-- Centene (PA Health & Wellness Medicaid + Wellcare MA), TRICARE East, VA CCN,
-- the national TPAs (Meritain, UMR), and AARP/UHC Medicare Supplement — plus
-- the PA Blue licensees (Highmark, Independence, Capital) and UPMC / Geisinger.
--
-- What was still missing were the national plans that ARE sold in PA but had
-- no payer_profiles row, so coverage-resolution fell through to free-text on
-- those cards. This migration adds the six genuinely-missing national plans
-- that are confirmed available in Pennsylvania for 2026:
--
--   1. ambetter_pa             — Ambetter from PA Health & Wellness (Centene
--                                ACA marketplace / Pennie; 39 PA counties).
--   2. oscar_health_pa         — Oscar Health Plan of Pennsylvania (Pennie
--                                marketplace; SE/NE PA counties).
--   3. bcbs_fep                — BCBS Federal Employee Program (administered
--                                in PA by Highmark; "R"-prefixed member IDs).
--   4. geha                    — GEHA, the national FEHB plan on the UHC /
--                                UMR platform (payer ID 39026).
--   5. anthem_bluecard         — Anthem / Elevance Health out-of-state Blue
--                                members, billed via BlueCard through the
--                                local PA Blue (umbrella / router row).
--   6. mutual_of_omaha_medsup  — Mutual of Omaha Medicare Supplement
--                                (Medigap; pays via Medicare crossover).
--
-- Deliberately NOT seeded (researched 2026-06; documented in
-- docs/payer-top-25-national-pa.md) because they are NOT available in PA:
--   * Molina Healthcare   — not on Pennie's 2026 carrier list, no PA MA and
--                           no PA Medicaid contract; exiting traditional MA
--                           after 2026. Seeding it would imply PA coverage
--                           that does not exist.
--   * WellPoint (Elevance/Amerigroup) — MA only in AZ/IA/NJ/TN/TX/WA/WV; no
--                           Pennsylvania plan.
--   * Kaiser Permanente, Health Care Service Corp (HCSC), GuideWell/Florida
--                           Blue — large nationally but do not operate in PA.
--
-- Data provenance & posture (same contract as 0128/0142/0149/0206/0207):
--   * Payer IDs / claims addresses / phones are from each payer's published
--     provider material (Ambetter PA Quick Reference Guide + provider manual,
--     UnitedHealthcare 2026 GEHA provider FAQ, Oscar provider manual, the
--     Independence Blue Cross professional payer-ID reference + Highmark
--     provider manual for FEP, PA Insurance Department 2026 rate filing for
--     Oscar). The admin edit drawer exposes per-row edit so a published
--     change is followed without a code change.
--   * Where a value could not be verified it is left NULL and flagged in
--     `notes` rather than guessed. We do NOT guess fax numbers (faxing PHI to
--     an unverified number is a HIPAA incident) — the only PA fax stored here
--     is Ambetter's medical-PA fax, which is printed on Ambetter's official
--     Quick Reference Guide.
--   * Shared payer IDs are expected and correct: bcbs_fep reuses Highmark's
--     54771 (Highmark administers FEP in PA), ambetter_pa reuses Centene's
--     68069, and geha reuses 39026 (the UMR platform GEHA migrated onto).
--     Differentiate the line of business by the member card, not the ID.
--
-- This migration populates BOTH the flat 0149 columns AND the jsonb / claim-
-- logic 0142 columns for the new rows in one pass (the lesson of 0206 — never
-- leave one representation empty for the claim builder / scrubber / ERA
-- reconciler / HCFA-1500 + appeal PDFs / admin drawer / OA-enrollment CSV).
--
-- Idempotent: INSERT ... ON CONFLICT (slug) DO NOTHING, and every completion
-- UPDATE is guarded (IS NULL / empty) and scoped to the six new slugs, so a
-- re-run — or a from-scratch replay — is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ──────────────────────────────────────────────────────────────────────
-- 1. SEED — six national plans available in PA (flat + base columns)
-- ──────────────────────────────────────────────────────────────────────
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
  -- ── Centene ACA marketplace (Pennie) ──
  ('ambetter_pa', 'Ambetter from PA Health & Wellness (Marketplace)',
   'Pennsylvania Health & Wellness, Inc.', 'Centene Corporation',
   'commercial', 'pa',
   '68069', '68069',
   '837p', false, true,
   '+18335104727', '+18335104727',
   'https://ambetter.pahealthwellness.com',
   'ambetter.pahealthwellness.com/provider-resources',
   'Centene ACA marketplace (Pennie) plan, on the exchange as "Ambetter from PA Health & Wellness" (formerly the marketplace line of PA Health & Wellness); expanded to 39 PA counties for 2026. Shares EDI payer ID 68069 with Centene''s PA Medicaid line (pa_health_and_wellness) — differentiate by the member card / plan, not the payer ID. Preferred clearinghouse Availity. Use the Pre-Auth Needed tool to confirm CPAP (E0601) PA.',
   180,
   'PO Box 5010', NULL, 'Farmington', 'MO', '63640',
   '+18335104727', NULL,
   'portal', '+18448274948', 7,
   ARRAY['KX']::text[], true, 'enrolled',
   'Member ID per card (Centene marketplace, typically all-numeric)',
   '2026-06-02T00:00:00Z', 'system:seed:0208'),

  -- ── Oscar Health (Pennie marketplace) ──
  ('oscar_health_pa', 'Oscar Health (Pennsylvania Marketplace)',
   'Oscar Health Plan of Pennsylvania, Inc.', 'Oscar Health, Inc.',
   'commercial', 'pa',
   'OSCAR', 'OSCAR',
   '837p', false, true,
   '+18556722755', '+18556722755',
   'https://provider.hioscar.com',
   'provider.hioscar.com',
   'Oscar Health Plan of Pennsylvania (HMO) — ACA marketplace via Pennie; PA Insurance Department 2026 filing covers SE/NE PA counties (Philadelphia, Montgomery, Chester, Delaware, Bucks, Lehigh, Northampton, Lancaster, Lackawanna, Luzerne, Monroe, Carbon, Wyoming). EDI payer ID OSCAR (Change Healthcare CPIDs 9638/7468; also routable via Availity) — confirm Office Ally enrollment before the first electronic submission (edi_enrollment_status=pending until confirmed). Sleep/CPAP utilization management is delegated to eviCore (855-252-1118, fax 800-540-2406).',
   180,
   'PO Box 52146', NULL, 'Phoenix', 'AZ', '85072',
   '+18556722755', NULL,
   'portal', NULL, 7,
   ARRAY['KX']::text[], true, 'pending',
   'Member ID varies by plan (card-driven)',
   '2026-06-02T00:00:00Z', 'system:seed:0208'),

  -- ── BCBS Federal Employee Program (PA via Highmark) ──
  ('bcbs_fep', 'BCBS Federal Employee Program (PA — via Highmark)',
   'Blue Cross and Blue Shield Service Benefit Plan', 'Blue Cross Blue Shield Association',
   'federal', 'pa',
   '54771', '54771',
   '837p', false, true,
   '+18009920246', '+18009920246',
   'https://providers.highmark.com',
   'providers.highmark.com',
   'BCBS Federal Employee Program (Service Benefit Plan). Member IDs begin with "R" + 8 digits. FEP is EXCLUDED from BlueCard — a claim for a PA-rendered service is administered by Highmark (PA''s FEP plan) under payer ID 54771, NOT the member''s home Blue plan. Timely filing follows the FEHB rule (file by Dec 31 of the year AFTER the date of service) in addition to Highmark''s 365-day default. Confirm E0601 precert on Highmark''s FEP prior-auth list.',
   365,
   'PO Box 890062', NULL, 'Camp Hill', 'PA', '17089',
   '+18009920246', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'R + 8 digits (FEP enrollment code)',
   '2026-06-02T00:00:00Z', 'system:seed:0208'),

  -- ── GEHA (national FEHB on the UHC / UMR platform) ──
  ('geha', 'GEHA (Government Employees Health Association)',
   'Government Employees Health Association, Inc.', 'GEHA',
   'federal', 'national',
   '39026', '39026',
   '837p', false, true,
   '+18774342336', '+18774342336',
   'https://www.geha.com/providers',
   'uhcprovider.com',
   'GEHA is a national FEHB plan that accesses the UnitedHealthcare Choice Plus network and migrated to the UHC/UMR claims platform — EDI payer ID is 39026 as of 2025-01-01 (the legacy 44054 is RETIRED; do not use). Note: 39026 is the same UMR-platform payer ID already used by the umr TPA row. Member IDs use a "G" prefix. Claims to GEHA, PO Box 21172, Eagan MN 55121 (appeals: PO Box 21324, Eagan MN). Timely filing per FEHB (file by Dec 31 of the year after service); exact contractual provider TFL not verified, left NULL.',
   NULL,
   'PO Box 21172', NULL, 'Eagan', 'MN', '55121',
   '+18774342336', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'G + 8 digits',
   '2026-06-02T00:00:00Z', 'system:seed:0208'),

  -- ── Anthem / Elevance out-of-state Blue (BlueCard router — umbrella) ──
  ('anthem_bluecard', 'Anthem / Elevance Health (out-of-state Blue — BlueCard)',
   'Anthem Blue Cross and Blue Shield (Elevance Health)', 'Elevance Health',
   'commercial', 'national',
   NULL, NULL,
   '837p', false, true,
   NULL, '+18006762583',
   'https://www.availity.com',
   NULL,
   'UMBRELLA / ROUTER ROW (not directly billable). Anthem/Elevance is NOT a Blue licensee in Pennsylvania — PA''s Blue plans are Highmark, Independence (IBX), and Capital BlueCross. A PA provider serving an out-of-state Anthem/Elevance Blue member files the claim to the LOCAL PA Blue plan by region (Highmark 54771 / IBX 54704 / Capital 23045) and BlueCard forwards it to the member''s home plan; identify the home plan by the 3-character alpha prefix on the member ID. Anthem has no single national commercial payer ID — its IDs are per-state via Availity (e.g., NY = 18454). Do NOT bill a national "Anthem" payer ID directly. Kept so coverage-resolution can attach a payer_profile to free-text Anthem cards before the CSR re-tags to the correct local Blue.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18006762583', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'not_applicable',
   '3-character alpha prefix + alphanumeric (home-plan prefix drives BlueCard routing)',
   '2026-06-02T00:00:00Z', 'system:seed:0208'),

  -- ── Mutual of Omaha Medicare Supplement (Medigap crossover) ──
  ('mutual_of_omaha_medsup', 'Mutual of Omaha Medicare Supplement',
   'Mutual of Omaha Insurance Company', 'Mutual of Omaha',
   'other', 'national',
   '71412', '71412',
   '837p', false, false,
   NULL, '+18007756000',
   'https://www.mutualofomaha.com',
   NULL,
   'Medicare Supplement (Medigap) — bill Original Medicare / the DME MAC (Noridian) PRIMARY first; Mutual of Omaha pays the Medicare cost-share via automatic COBA crossover, so a direct claim is rarely needed. No prior authorization. EDI payer ID 71412 (verify in Office Ally before the first direct submission). A dedicated Medigap claims PO Box was not verified — obtain it from a current EOB / provaccess.com if direct paper billing is required (corporate HQ: 3300 Mutual of Omaha Plaza, Omaha NE 68175). Set as SECONDARY on the claim header, not primary.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18007756000', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], true, 'pending',
   'Alphanumeric policy number (no standardized public pattern)',
   '2026-06-02T00:00:00Z', 'system:seed:0208')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────────────
-- 2. COMPLETE — fill the jsonb / claim-logic 0142 columns for the six new
--    rows from the flat data just inserted (mirrors 0206's derivations,
--    scoped to the new slugs). 0206 already ran on existing rows; because
--    it precedes this file in the replay order it does NOT see these rows,
--    so we derive their second representation here. All guarded + idempotent.
-- ──────────────────────────────────────────────────────────────────────

-- 2a. jsonb claims_mailing_address ← flat claims address (read by the
--     HCFA-1500 paper-claim MAIL-TO block). Rows with no flat address
--     (anthem_bluecard router, mutual_of_omaha_medsup) are skipped by guard.
UPDATE "resupply"."payer_profiles" SET
  "claims_mailing_address" = jsonb_strip_nulls(jsonb_build_object(
    'line1', "claims_address_line1",
    'line2', "claims_address_line2",
    'city',  "claims_city",
    'state', "claims_state",
    'zip',   "claims_zip"
  ))
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha',
                 'anthem_bluecard', 'mutual_of_omaha_medsup')
  AND "claims_mailing_address" IS NULL
  AND "claims_address_line1" IS NOT NULL
  AND "claims_city"  IS NOT NULL
  AND "claims_state" IS NOT NULL
  AND "claims_zip"   IS NOT NULL;
--> statement-breakpoint

-- 2b. GEHA appeals address (verified from the UHC 2026 GEHA provider FAQ).
UPDATE "resupply"."payer_profiles" SET
  "appeals_mailing_address" =
    '{"line1":"PO Box 21324","city":"Eagan","state":"MN","zip":"55121"}'::jsonb
WHERE "slug" = 'geha'
  AND "appeals_mailing_address" IS NULL;
--> statement-breakpoint

-- 2c. ERA payer id ← 5010 payer id (the reconciler keys remits off
--     era_payer_id). The anthem_bluecard router has no 5010 id → stays NULL.
UPDATE "resupply"."payer_profiles" SET
  "era_payer_id" = "edi_5010_payer_id"
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha',
                 'anthem_bluecard', 'mutual_of_omaha_medsup')
  AND "era_payer_id" IS NULL
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- 2d. ERA enrollment is required for every row that bills electronically
--     (i.e. carries a 5010 id). The router row stays false (default).
UPDATE "resupply"."payer_profiles" SET
  "era_enrollment_required" = true
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha',
                 'mutual_of_omaha_medsup')
  AND "era_enrollment_required" = false;
--> statement-breakpoint

-- 2e. Claim-logic required_modifiers_dme ← admin required_claim_modifiers
--     (so the claim builder / scrubber enforce the same KX set the new rows
--     declare on the admin surface). mutual_of_omaha_medsup is empty (no DME
--     modifiers on a crossover Medigap) and is skipped by guard.
UPDATE "resupply"."payer_profiles" SET
  "required_modifiers_dme" = "required_claim_modifiers"
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha',
                 'anthem_bluecard', 'mutual_of_omaha_medsup')
  AND COALESCE(array_length("required_modifiers_dme", 1), 0) = 0
  AND COALESCE(array_length("required_claim_modifiers", 1), 0) > 0;
--> statement-breakpoint

-- 2f. Enrollment posture: the claim preflight / Office-Ally batch treat
--     enrollment_status='unknown' as not-ready. Resolve it from the
--     already-set edi_enrollment_status (same mapping as 0206).
UPDATE "resupply"."payer_profiles" SET
  "enrollment_status" = CASE
    WHEN "edi_enrollment_status" = 'enrolled'       THEN 'active'
    WHEN "edi_enrollment_status" = 'pending'        THEN 'pending'
    WHEN "edi_enrollment_status" = 'not_applicable' THEN 'not_required'
    ELSE "enrollment_status"
  END
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha',
                 'anthem_bluecard', 'mutual_of_omaha_medsup')
  AND "enrollment_status" = 'unknown';
--> statement-breakpoint

-- 2g. Referring-provider-NPI requirement: the 0142 cohort carries this true
--     for every billable line of business whose 837P edits reject a missing
--     2310A NPI (commercial / federal here). The anthem_bluecard router and
--     the Medigap-crossover 'other' row stay false (no direct DME edits).
UPDATE "resupply"."payer_profiles" SET
  "requires_referring_provider_npi" = true
WHERE "slug" IN ('ambetter_pa', 'oscar_health_pa', 'bcbs_fep', 'geha')
  AND "requires_referring_provider_npi" = false;
--> statement-breakpoint

-- 2h. member_id_pattern for the two rows with an unambiguous published
--     format (FEP "R"+8, GEHA "G"+8). The others vary by plan / card and are
--     left NULL — the claim-builder validator treats a NULL pattern as a
--     skipped soft check, so a conservative omission is harmless.
UPDATE "resupply"."payer_profiles" SET
  "member_id_pattern" = '^R\d{8}$'
WHERE "slug" = 'bcbs_fep'
  AND "member_id_pattern" IS NULL;
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET
  "member_id_pattern" = '^G\d{8}$'
WHERE "slug" = 'geha'
  AND "member_id_pattern" IS NULL;
--> statement-breakpoint
