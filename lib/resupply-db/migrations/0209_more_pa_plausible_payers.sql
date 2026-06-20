-- 0209_more_pa_plausible_payers — broaden the payer catalog with 25 more
-- insurers/payers that may be encountered in Pennsylvania DME/CPAP billing.
--
-- Why
-- ---
-- 0208 added the top NATIONAL plans confirmed sold in PA. This follow-up
-- widens coverage to the next tier a PA DME supplier plausibly bills — so
-- coverage-resolution stops falling through to free text on these cards:
--
--   * FEHB federal-employee plans (federal employees live statewide):
--     MHBP, NALC HBP, APWU Health Plan, Compass Rose, SAMBA. Most bill
--     under their PPO network's parent payer ID (Cigna 62308 / UHC 87726).
--   * National self-funded-employer TPAs: Allied, HealthSmart, Luminare
--     (ex-Trustmark/CoreSource), WebTPA, Imagine360 (RBP), Nova, MagnaCare
--     /Brighton, EBMS.
--   * Rental PPO networks that only reprice (ROUTER rows, like the existing
--     anthem_bluecard / pa_chip): First Health, MultiPlan/PHCS — you bill
--     the plan on the member card, not the network.
--   * Additional Medicare Supplement (Medigap) with distinct payer IDs:
--     Cigna Medigap (13193), Aetna Senior Supplemental (62118).
--   * The PA Medicare HMO line of Health Partners (Jefferson Health Plans),
--     the Medicare sibling of the existing health_partners_pa_medicaid row.
--   * PA CHIP held by the Blues: UPMC for Kids, Keystone Health Plan East
--     (IBX) CHIP, Highmark Healthy Kids — each bills under its Blue's
--     standard payer ID and REQUIRES a PA PROMISe provider ID.
--   * Workers'-comp / auto-no-fault casualty payers a DME supplier bills
--     after an injury / MVA: Gallagher Bassett, Broadspire, ESIS (WC TPAs)
--     and State Farm (auto MedPay/PIP). These do NOT clear through Office
--     Ally — WC/auto e-bills route through specialized clearinghouses
--     (Jopari / Data Dimensions / Carisk / P2P), so they are paper_1500 /
--     paper_only with the WC payer ID recorded in notes only.
--
-- Deliberately NOT seeded (researched 2026-06; not available in PA):
--   * Zing Health — Medicare Advantage only in IL / IN / MI / TN; no PA
--     plan in any county (documented in docs/payer-additional-pa-plausible.md).
--
-- Data posture (same contract as 0128/0142/0149/0206/0207/0208):
--   * Payer IDs / addresses / phones are from each payer's published
--     provider material, OPM FEHB brochures, or clearinghouse payer lists.
--   * UNVERIFIED values are left NULL and flagged in notes, never guessed
--     (MHBP's electronic payer ID, ESIS's WC-clearinghouse id, several
--     plan-specific claims boxes, and most TPA/FEHB timely-filing counts).
--     No fax numbers were invented.
--   * Shared parent payer IDs are expected: the FEHB plans submit under
--     Cigna 62308 / UHC 87726, the PA CHIP lines under their Blue's id
--     (UPMC 23281, Highmark 54771), and Jefferson Medicare under 80142.
--     (See the PR-#478 discussion on ERA resolution of shared ids — that is
--     a separate resolver concern, tracked independently.)
--
-- Both representations (flat 0149 + jsonb/claim-logic 0142) are populated:
-- the INSERT carries the flat columns, then a completion block scoped by
-- requirements_last_verified_by = 'system:seed:0209' derives the jsonb /
-- claim-logic side (mirrors 0206). Idempotent: INSERT ... ON CONFLICT
-- (slug) DO NOTHING and guarded UPDATEs, so a re-run / replay is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ──────────────────────────────────────────────────────────────────────
-- 1. SEED — 25 more PA-plausible payers (flat + base columns)
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
  -- ── FEHB federal-employee plans (bill under the PPO network's parent id) ──
  ('mhbp_fehb', 'Mail Handlers Benefit Plan (MHBP — FEHB)',
   'First Health Life & Health Insurance Company', 'Aetna (CVS Health)',
   'federal', 'national',
   NULL, NULL,
   '837p', false, true,
   '+18004107778', '+18004107778',
   'https://www.mhbp.com', NULL,
   'FEHB plan for postal/federal employees (OPM contract CS1146), administered on Aetna''s network (First Health / Aetna Signature Administrators). EDI payer ID UNVERIFIED — MHBP likely routes under Aetna 60054 but this was not confirmed; verify the payer ID on the member card before electronic submission. Timely filing per FEHB: file by Dec 31 of the year after the date of service. Paper claims: MHBP/GDS, PO Box 7710, London KY 40742 (verify per card).',
   NULL,
   'PO Box 7710', NULL, 'London', 'KY', '40742',
   '+18004107778', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'pending',
   'See member card (Aetna-administered)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('nalc_hbp_fehb', 'NALC Health Benefit Plan (FEHB)',
   'NALC Health Benefit Plan', 'National Association of Letter Carriers',
   'federal', 'national',
   '62308', '62308',
   '837p', false, true,
   '+18886366252', '+18886366252',
   'https://www.nalchbp.org', NULL,
   'FEHB plan for letter carriers; PPO network and claims administered by Cigna — submit 837P under Cigna payer ID 62308. Paper: NALC Health Benefit Plan, c/o Cigna Payer 62308, PO Box 188004, Chattanooga TN 37422-8004. Timely filing 90 days in-network / 180 days out-of-network (Cigna terms). CPAP via Cigna precert pathway.',
   180,
   'PO Box 188004', NULL, 'Chattanooga', 'TN', '37422',
   '+18886366252', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'Cigna-network member ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('apwu_health_fehb', 'APWU Health Plan (FEHB)',
   'APWU Health Plan', 'American Postal Workers Union',
   'federal', 'national',
   '62308', '62308',
   '837p', false, true,
   '+18002222798', '+18002222798',
   'https://www.apwuhp.com', NULL,
   'FEHB plan; PPO network = Cigna in all states — submit 837P under Cigna payer ID 62308 (Virgin Islands uses 44444). Timely filing 90 days in-network / 180 days out-of-network. CPAP via Cigna precert. Paper-claims box varies — submit electronically to Cigna 62308 and verify any paper address on the member card.',
   180,
   NULL, NULL, NULL, NULL, NULL,
   '+18002222798', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'Cigna-network member ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('compass_rose_fehb', 'Compass Rose Health Plan (FEHB)',
   'Compass Rose Benefits Group', 'Compass Rose Benefits Group',
   'federal', 'national',
   '87726', '87726',
   '837p', false, true,
   '+18884389135', '+18884389135',
   'https://www.compassrosebenefits.com', NULL,
   'FEHB plan; network = UnitedHealthcare Choice Plus — submit 837P under UHC payer ID 87726. Paper: Compass Rose Health Plan, PO Box 8095, Wausau WI 54402-8095. Timely filing per UHC network terms (exact day-count unverified). CPAP via the UHC prior-auth pathway.',
   NULL,
   'PO Box 8095', NULL, 'Wausau', 'WI', '54402',
   '+18884389135', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'UHC Choice Plus member ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('samba_fehb', 'SAMBA Health Benefit Plan (FEHB)',
   'Special Agents Mutual Benefit Association', 'SAMBA',
   'federal', 'national',
   '62308', '62308',
   '837p', false, true,
   '+18006386589', '+18006386589',
   'https://www.sambaplans.com', NULL,
   'FEHB plan; PPO network = Cigna — submit 837P under Cigna payer ID 62308 (eligibility/status via SAMBA WebConnect / Change Healthcare 37259). Paper: Cigna Payer 62308, PO Box 188007, Chattanooga TN 37422. CPAP via Cigna precert.',
   NULL,
   'PO Box 188007', NULL, 'Chattanooga', 'TN', '37422',
   '+18006386589', NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'Cigna-network member ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── National self-funded-employer TPAs ──
  ('allied_benefit_systems', 'Allied Benefit Systems (TPA)',
   'Allied Benefit Systems, LLC', 'Allied Benefit Systems',
   'commercial', 'multi_state',
   '37308', '37308',
   '837p', false, true,
   NULL, NULL,
   'https://www.alliedbenefit.com/Providers', NULL,
   'National self-funded-employer TPA (Chicago). EDI payer ID 37308. Paper: PO Box 211651, Eagan MN 55121. DME prior-auth is plan-/group-specific (often a third-party UM vendor) — confirm per member card. Timely filing per the group contract.',
   NULL,
   'PO Box 211651', NULL, 'Eagan', 'MN', '55121',
   NULL, NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('healthsmart_benefit_solutions', 'HealthSmart Benefit Solutions (TPA)',
   'HealthSmart Benefit Solutions, Inc.', 'UnitedHealth Group',
   'commercial', 'multi_state',
   '87815', '87815',
   '837p', false, true,
   '+18006870500', '+18006870500',
   'https://www.healthsmartproviderportal.com', NULL,
   'National TPA (UnitedHealth Group). Primary EDI payer ID 87815 (legacy Wells Fargo TPA / Acordia National); a second line uses 37272 (legacy JSL), and HealthSmart Network Solutions runs on UMR — CONFIRM the correct payer ID on the member card. Claims address varies by plan; use the card. DME PA plan-specific.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18006870500', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card; multiple HealthSmart lines',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('luminare_health', 'Luminare Health (ex-Trustmark Health Benefits / CoreSource)',
   'Luminare Health Benefits, Inc.', 'Health Care Service Corporation',
   'commercial', 'multi_state',
   '35187', '35187',
   '837p', false, true,
   NULL, NULL,
   'https://www.luminarehealth.com', NULL,
   'National TPA, rebranded from Trustmark Health Benefits (formerly CoreSource) in 2023; owned by HCSC. EDI payer ID 35187 (some legacy plans show other IDs — confirm per card). Paper: Luminare Health, PO Box 2920, Clinton IA (ZIP unverified, commonly 52733). DME PA plan-specific.',
   NULL,
   'PO Box 2920', NULL, 'Clinton', 'IA', NULL,
   NULL, NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('webtpa', 'WebTPA (TPA)',
   'WebTPA Employer Services, LLC', 'GuideWell',
   'commercial', 'multi_state',
   '75261', '75261',
   '837p', false, true,
   '+18443804552', '+18443804552',
   'https://www.webtpa.com', NULL,
   'National TPA (GuideWell family; also branded CHEC). EDI payer ID 75261. Paper: WebTPA, PO Box 99906, Grapevine TX 76099-9706. DME PA plan-specific; confirm per card.',
   NULL,
   'PO Box 99906', NULL, 'Grapevine', 'TX', '76099',
   '+18443804552', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('imagine360', 'Imagine360 (reference-based pricing; formerly ELAP)',
   'Imagine360, LLC', 'Imagine360',
   'commercial', 'multi_state',
   '48143', '48143',
   '837p', false, true,
   '+18008277223', '+18008277223',
   'https://www.imagine360.com', NULL,
   'Reference-based-pricing (RBP) plan administrator (absorbed ELAP Services; HQ Wayne PA). EDI payer ID 48143 (Imagine360 Administrators / GPA). RBP plans reprice to a Medicare-reference percent and are open-access; claims may route to a specific TPA per the member card — confirm the submission path. DME PA plan-specific.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18008277223', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per plan card (RBP)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('nova_healthcare_admin', 'Nova Healthcare Administrators (TPA)',
   'Nova Healthcare Administrators, Inc.', 'Independent Health',
   'commercial', 'multi_state',
   '16644', '16644',
   '837p', false, true,
   '+18009995703', '+18009995703',
   'https://www.novahealthcare.com/providers', NULL,
   'Self-funded-employer TPA (Buffalo NY; affiliated with Independent Health). Regional (Western NY) emphasis — present in PA only via a PA employer/member carrying a Nova card. EDI payer ID 16644. Paper: PO Box 9050, Williamsville NY 14231 (a Nova lockbox at PO Box 211428, Eagan MN also appears — verify per card). DME PA plan-specific.',
   NULL,
   'PO Box 9050', NULL, 'Williamsville', 'NY', '14231',
   '+18009995703', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('magnacare', 'MagnaCare / Brighton Health Plan Solutions',
   'Brighton Health Plan Solutions, LLC', 'Brighton Health Plan Solutions',
   'commercial', 'multi_state',
   '11303', '11303',
   '837p', false, true,
   '+18003526465', '+18008456592',
   'https://www.magnacare.com', NULL,
   'Brighton Health Plan Solutions TPA; MagnaCare is its proprietary network (NY/NJ/CT). Present in PA only via out-of-area members on a BHPS-administered plan — borderline for a PA catalog. EDI payer ID 11303 (may diverge by plan — use the card). Paper: MagnaCare, PO Box 1001, Garden City NY 11530. DME PA plan-specific.',
   NULL,
   'PO Box 1001', NULL, 'Garden City', 'NY', '11530',
   '+18008456592', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per plan card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('ebms', 'EBMS — Employee Benefit Management Services (TPA)',
   'EBMS, Inc.', 'EBMS',
   'commercial', 'multi_state',
   '81039', '81039',
   '837p', false, true,
   '+18662471443', '+18662471443',
   'https://www.ebms.com', NULL,
   'National self-funded-employer TPA (Billings MT). EDI payer ID 81039 (Availity). Claims address is plan-specific — submit electronically via Availity to 81039. DME PA plan-specific.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18662471443', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Per employer-group card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── Rental PPO networks (ROUTER rows — bill the plan on the card) ──
  ('first_health_network', 'First Health Network (rental PPO — bill the plan on the card)',
   'First Health Group Corp.', 'Aetna (CVS Health)',
   'commercial', 'national',
   NULL, NULL,
   '837p', false, false,
   NULL, NULL,
   'https://www.firsthealth.com', NULL,
   'ROUTER / NETWORK ROW (not directly billable). First Health is a rental/"wrap" PPO network (Coventry → Aetna) leased by self-funded plans and other carriers. For DME you bill the plan/TPA on the member card, NOT First Health — First Health only reprices. First Health''s own claims payer ID 95019 applies only when the card explicitly directs First Health. Kept so coverage-resolution can attach a payer_profile to a free-text First Health card.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL,
   NULL, NULL, NULL,
   ARRAY[]::text[], true, 'not_applicable',
   'Bill the plan on the card; First Health is a network, not the payer',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('multiplan_phcs', 'MultiPlan / PHCS (rental PPO — bill the plan on the card)',
   'MultiPlan, Inc. (Claritev)', 'Claritev',
   'commercial', 'national',
   NULL, NULL,
   '837p', false, false,
   NULL, '+18005330090',
   'https://www.multiplan.us', NULL,
   'ROUTER / NETWORK ROW (not directly billable). MultiPlan/PHCS (rebranded Claritev) is a rental PPO network that only reprices — bill the payer/TPA on the back of the member card (identified by the PHCS/MultiPlan logo). It has no adjudication payer ID of its own. Network professional agreements specify a 90-day filing window. Kept so coverage-resolution can attach a payer_profile to a free-text PHCS/MultiPlan card.',
   90,
   NULL, NULL, NULL, NULL, NULL,
   '+18005330090', NULL,
   NULL, NULL, NULL,
   ARRAY[]::text[], true, 'not_applicable',
   'Bill the payer on the card (PHCS/MultiPlan logo = network discount)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── Additional Medicare Supplement (Medigap; distinct payer IDs) ──
  ('cigna_medsup', 'Cigna Medicare Supplement (Medigap)',
   'Cigna Health & Life Insurance Company', 'The Cigna Group',
   'other', 'national',
   '13193', '13193',
   '837p', false, false,
   NULL, '+18009971654',
   'https://www.cigna.com/medicare/supplemental', NULL,
   'Medicare Supplement (Medigap) — bill Original Medicare / the DME MAC (Noridian) PRIMARY first; Cigna pays the Part B coinsurance via Medicare crossover. No prior authorization. EDI payer ID 13193 (distinct from Cigna commercial 62308). Paper: Cigna Phoenix Claim Services, PO Box 55290, Phoenix AZ 85078. Set as SECONDARY on the claim header.',
   NULL,
   'PO Box 55290', NULL, 'Phoenix', 'AZ', '85078',
   '+18009971654', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], true, 'pending',
   'Cigna Supplemental policy number per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('aetna_medsup', 'Aetna Medicare Supplement (Medigap)',
   'Continental Life Insurance Company of Brentwood', 'Aetna (CVS Health)',
   'other', 'national',
   '62118', '62118',
   '837p', false, false,
   NULL, '+18886246290',
   'https://www.aetnaseniorproducts.com', NULL,
   'Medicare Supplement (Medigap) — Aetna Senior Supplemental (Continental Life / American Continental). Bill Original Medicare / the DME MAC PRIMARY first; pays the Part B coinsurance via crossover. No prior authorization. EDI payer ID 62118 (distinct from Aetna 60054). Paper: Aetna Senior Supplemental, PO Box 14770, Lexington KY 40512-4770. Set as SECONDARY.',
   NULL,
   'PO Box 14770', NULL, 'Lexington', 'KY', '40512',
   '+18886246290', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], true, 'pending',
   'Continental Life / Aetna SSI policy number per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── PA Medicare HMO (Health Partners / Jefferson Health Plans) ──
  ('jefferson_health_plans_medicare', 'Jefferson Health Plans Medicare (Health Partners Medicare HMO)',
   'Health Partners Plans, Inc.', 'Jefferson Health',
   'medicare_advantage', 'pa',
   '80142', '80142',
   '837p', false, true,
   NULL, NULL,
   'https://www.jeffersonhealthplans.com', NULL,
   'Medicare HMO line of Health Partners Plans (d/b/a Jefferson Health Plans), Philadelphia — the Medicare sibling of the existing health_partners_pa_medicaid (Medicaid) row. EDI payer ID 80142. Paper: Jefferson Health Plans, PO Box 211123, Eagan MN 55121. DME PA via the Jefferson / Health Partners provider portal / NaviNet.',
   NULL,
   'PO Box 211123', NULL, 'Eagan', 'MN', '55121',
   NULL, NULL,
   'portal', NULL, 14,
   ARRAY['KX']::text[], true, 'enrolled',
   'Health Partners / Jefferson member ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── PA CHIP held by the Blues (bill under the Blue's id; PROMISe ID req'd) ──
  ('upmc_for_kids_chip', 'UPMC for Kids (PA CHIP)',
   'UPMC Health Plan, Inc.', 'UPMC',
   'medicaid_mco', 'pa',
   '23281', '23281',
   '837p', false, true,
   '+18004257800', NULL,
   'https://www.upmchealthplan.com/providers', NULL,
   'PA CHIP held by UPMC Health Plan (statewide, all 67 counties as of 2025). Bills under UPMC Health Plan payer ID 23281. Paper: UPMC for Kids, PO Box 2999, Pittsburgh PA 15230. DME covered; PA via UPMC Provider OnLine / 1-800-425-7800. Any rendering/ordering/referring provider needs a valid PA PROMISe ID or the claim denies.',
   NULL,
   'PO Box 2999', NULL, 'Pittsburgh', 'PA', '15230',
   '+18004257800', NULL,
   'portal', NULL, 7,
   ARRAY['KX']::text[], true, 'enrolled',
   '10-digit UPMC member ID; PROMISe ID required on claim',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('ibx_chip', 'Keystone Health Plan East CHIP (Independence Blue Cross)',
   'Keystone Health Plan East, Inc.', 'Independence Health Group',
   'medicaid_mco', 'pa',
   NULL, NULL,
   '837p', false, true,
   '+18002752583', '+18002752583',
   'https://www.ibx.com', NULL,
   'PA CHIP held by Independence Blue Cross (Keystone Health Plan East), SE PA. Professional claims route by the member-ID prefix via the IBX payer-ID grid (ibx.com/edi) — there is no single CHIP-specific payer ID, so the office_ally/edi id is intentionally NULL; confirm the correct id and claims box per the member''s prefix before submission. DME covered; PA via NaviNet. Requires a valid PA PROMISe ID.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18002752583', NULL,
   'portal', NULL, 5,
   ARRAY['KX']::text[], true, 'pending',
   'IBX alpha-prefix per card; route by prefix; PROMISe ID required',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('highmark_chip', 'Highmark Healthy Kids (PA CHIP)',
   'Highmark Inc.', 'Highmark Health',
   'medicaid_mco', 'pa',
   '54771', '54771',
   '837p', false, true,
   '+18669755054', '+18669755054',
   'https://providers.highmark.com', NULL,
   'PA CHIP held by Highmark (branded Highmark Healthy Kids), Highmark service area. Bills under Highmark''s standard PA payer ID 54771 (the SB865 id also appears — confirm the correct variant per member card). DME covered; PA via Highmark provider channels. Requires a valid PA PROMISe ID or the claim denies. Timely filing commonly 365 days (Highmark default).',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18669755054', NULL,
   'portal', NULL, 5,
   ARRAY['KX']::text[], true, 'enrolled',
   'Highmark alpha-prefix per card; PROMISe ID required',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  -- ── Workers' comp / auto no-fault casualty (NOT Office Ally — WC/auto EDI) ──
  ('gallagher_bassett_wc', 'Gallagher Bassett (Workers'' Compensation TPA)',
   'Gallagher Bassett Services, Inc.', 'Arthur J. Gallagher & Co.',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18337076338',
   'https://www.gallagherbassett.com', NULL,
   'National workers''-comp TPA (Arthur J. Gallagher; also administers AIG WC). Office Ally does NOT clear workers'' comp — WC e-bills route through specialized clearinghouses (Jopari / Data Dimensions / Carisk / P2P); Gallagher Bassett''s WC-clearinghouse payer ID is TP057 (verify current routing). DME after a work injury is adjuster-authorized under the accepted claim, governed by PA WC rules (Bureau of WC 717-772-4447), not a commercial PA workflow.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18337076338', NULL,
   'phone', NULL, 30,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('broadspire_wc', 'Broadspire (Workers'' Compensation TPA)',
   'Broadspire Services, Inc.', 'Crawford & Company',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18554987574',
   'https://www.choosebroadspire.com', NULL,
   'National workers''-comp TPA (Crawford & Company). Office Ally does NOT clear WC — Broadspire''s current WC e-bill payer ID is E8088 via the Carisk clearinghouse (the older TP021 Availity id is RETIRED; do not use). DME after a work injury is adjuster-authorized under the accepted claim, per PA WC rules.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18554987574', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('esis_wc', 'ESIS (Workers'' Compensation TPA)',
   'ESIS, Inc.', 'Chubb',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18002338931',
   'https://www.esis.com', NULL,
   'National workers''-comp TPA (a Chubb company). Office Ally does NOT clear WC; ESIS accepts X12 837 WC e-bills but the routable WC-clearinghouse payer ID is UNVERIFIED — confirm via your WC clearinghouse directory before submitting (some routing via netclaim.net, 866-789-3747). DME after a work injury is adjuster-authorized under the accepted claim, per PA WC rules.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18002338931', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0209'),

  ('state_farm_auto', 'State Farm (Auto MedPay / PIP — DME after MVA)',
   'State Farm Mutual Automobile Insurance Company', 'State Farm',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18007325246',
   'https://b2b.statefarm.com', NULL,
   'Auto no-fault / MedPay / PIP — pays for DME after a motor-vehicle accident under the member''s first-party auto medical coverage (PA is a choice no-fault state under the MVFRL). Office Ally does NOT clear auto claims; State Farm''s P&C medical e-bill payer ID is 31059 (do NOT use 31053 — that is State Farm Health Insurance, a different line); submit via the State Farm B2B medical e-billing portal / an auto clearinghouse. No standard prior auth — bills are reviewed against the auto claim; the member identifier is the auto CLAIM NUMBER, not a health member ID.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18007325246', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (not a health member ID)',
   '2026-06-02T00:00:00Z', 'system:seed:0209')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────────────
-- 2. COMPLETE — derive the jsonb / claim-logic 0142 columns for the new
--    rows from the flat data just inserted. Scoped by the seed stamp so a
--    single predicate covers all 25 rows; guarded + idempotent (mirrors
--    0206). 0206 precedes this file in replay order, so it does not see
--    these rows — we derive their second representation here.
-- ──────────────────────────────────────────────────────────────────────

-- 2a. jsonb claims_mailing_address ← flat claims address (HCFA-1500 MAIL-TO).
--     Rows with no full flat address (the TPAs/routers/WC rows, and the
--     no-ZIP Luminare row) are skipped by the NOT NULL guards.
UPDATE "resupply"."payer_profiles" SET
  "claims_mailing_address" = jsonb_strip_nulls(jsonb_build_object(
    'line1', "claims_address_line1",
    'line2', "claims_address_line2",
    'city',  "claims_city",
    'state', "claims_state",
    'zip',   "claims_zip"
  ))
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND "claims_mailing_address" IS NULL
  AND "claims_address_line1" IS NOT NULL
  AND "claims_city"  IS NOT NULL
  AND "claims_state" IS NOT NULL
  AND "claims_zip"   IS NOT NULL;
--> statement-breakpoint

-- 2b. ERA payer id ← 5010 payer id. Router / WC / auto rows and the
--     id-UNVERIFIED rows (MHBP, IBX CHIP) have a NULL 5010 id → stay NULL.
UPDATE "resupply"."payer_profiles" SET
  "era_payer_id" = "edi_5010_payer_id"
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND "era_payer_id" IS NULL
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- 2c. ERA enrollment is required for every row that bills electronically
--     (carries a 5010 id). Router / WC / auto rows stay false (default).
UPDATE "resupply"."payer_profiles" SET
  "era_enrollment_required" = true
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND "era_enrollment_required" = false
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- 2d. Claim-logic required_modifiers_dme ← admin required_claim_modifiers
--     (so the scrubber enforces the same KX the new rows declare). The
--     router / Medigap / WC / auto rows declare no modifiers and are skipped.
UPDATE "resupply"."payer_profiles" SET
  "required_modifiers_dme" = "required_claim_modifiers"
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND COALESCE(array_length("required_modifiers_dme", 1), 0) = 0
  AND COALESCE(array_length("required_claim_modifiers", 1), 0) > 0;
--> statement-breakpoint

-- 2e. Enrollment posture ← edi_enrollment_status (same mapping as 0206).
UPDATE "resupply"."payer_profiles" SET
  "enrollment_status" = CASE
    WHEN "edi_enrollment_status" = 'enrolled'       THEN 'active'
    WHEN "edi_enrollment_status" = 'pending'        THEN 'pending'
    WHEN "edi_enrollment_status" = 'not_applicable' THEN 'not_required'
    ELSE "enrollment_status"
  END
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND "enrollment_status" = 'unknown';
--> statement-breakpoint

-- 2f. Referring-provider-NPI requirement: true for the billable medical
--     lines whose 837P edits reject a missing 2310A NPI (federal FEHB,
--     commercial TPAs, the Medicare HMO, the CHIP lines). The rental-network
--     ROUTER rows (not billed directly), the Medigap-crossover 'other' rows,
--     and the WC/auto rows stay false.
UPDATE "resupply"."payer_profiles" SET
  "requires_referring_provider_npi" = true
WHERE "requirements_last_verified_by" = 'system:seed:0209'
  AND "requires_referring_provider_npi" = false
  AND "line_of_business" IN ('federal', 'commercial', 'medicare_advantage', 'medicaid_mco')
  AND "slug" NOT IN ('first_health_network', 'multiplan_phcs');
--> statement-breakpoint
