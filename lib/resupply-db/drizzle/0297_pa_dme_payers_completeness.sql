-- 0210_pa_dme_payers_completeness — 25 more payers a PA DME/CPAP supplier may
-- bill, seeded with as much verified billing detail as each publishes.
--
-- Why
-- ---
-- Rounds out the catalog with the remaining payer classes a PA DME company
-- touches, and (per request) fills EVERY field that can be verified per row:
--
--   * PA Community HealthChoices (Medicaid LTSS managed long-term care — a
--     very DME-heavy population): UPMC CHC, Keystone First CHC, PA Health &
--     Wellness CHC.
--   * Federal DME-relevant programs: CHAMPVA, Railroad Medicare (Palmetto
--     GBA), TRICARE For Life (WPS), and the federal Black Lung program (DOL
--     DCMWC — pays oxygen/PAP/DME for coal miners; relevant in PA coal country).
--   * PA Medicare Advantage / D-SNP not yet catalogued: Aetna Medicare D-SNP,
--     Cigna Preferred Medicare (→ "HealthSpring" 2026), Highmark Community
--     Blue Medicare HMO, UPMC for Life Dual (Complete Care D-SNP).
--   * Commercial / TPA: Independence Administrators (IBX self-funded TPA),
--     Surest (a UnitedHealthcare plan).
--   * Auto no-fault / MedPay (DME after a motor-vehicle accident; PA is a
--     choice no-fault state under the MVFRL): Progressive, Allstate,
--     Nationwide, GEICO, USAA.
--   * Workers'-comp carriers relevant in PA (several PA-domiciled): Berkshire
--     Hathaway GUARD (Wilkes-Barre), Eastern Alliance (Lancaster), Donegal
--     (Marietta), AmeriHealth Casualty (Philadelphia), Chubb, Zurich, CNA.
--
-- Data posture (same contract as 0128/0142/0149/0206/0207/0208/0209):
--   * Every payer ID / address / phone is from the payer's published provider
--     material, OPM/DOL/CMS, PA DHS, or a clearinghouse payer list.
--   * UNVERIFIED values are left NULL and flagged in notes, never guessed; no
--     fax number is invented (the only faxes stored are ones printed on an
--     official doc: Keystone First CHC UM fax, Cigna/eviCore DME fax,
--     AmeriHealth Casualty claim fax).
--   * Two important caveats are encoded in notes, NOT in the structured id:
--       - Railroad Medicare (00882) takes Part B physician services only —
--         CPAP/PAP/oxygen for a railroad beneficiary bill to the DME MAC
--         (Noridian Jurisdiction A in PA = medicare_dme_noridian), not here.
--       - PA Health & Wellness CHC is 68069; the separate AmeriHealth Caritas
--         PA CHC (77062 / PO Box 7110) is a DIFFERENT plan and is not this row.
--   * Auto / workers'-comp / Black Lung do NOT clear through Office Ally — they
--     route through P&C / WC clearinghouses (Jopari / Data Dimensions / Carisk)
--     or the DOL OWCP portal — so they are paper_1500 / paper_only with the
--     clearinghouse payer ID recorded in notes only, and are claim-number /
--     adjuster driven (no fixed claims PO box unless the carrier publishes one,
--     e.g. AmeriHealth Casualty PO Box 535370).
--
-- Both representations (flat 0149 + jsonb/claim-logic 0142) are populated: the
-- INSERT carries the flat columns, then a completion block scoped by
-- requirements_last_verified_by = 'system:seed:0210' derives the jsonb /
-- claim-logic side (mirrors 0206). Idempotent: INSERT ... ON CONFLICT (slug)
-- DO NOTHING and guarded UPDATEs, so a re-run / replay is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ──────────────────────────────────────────────────────────────────────
-- 1. SEED — 25 PA DME-relevant payers (flat + base columns)
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
  -- ── PA Community HealthChoices (Medicaid LTSS) ──
  ('upmc_community_healthchoices', 'UPMC Community HealthChoices (PA Medicaid LTSS)',
   'UPMC Health Plan, Inc.', 'UPMC',
   'medicaid_mco', 'pa',
   '23281', '23281',
   '837p', false, true,
   '+18004257800', '+18448609303',
   'https://www.upmchealthplan.com/providers', NULL,
   'PA Medicaid Community HealthChoices (LTSS managed long-term care), statewide. Bills under UPMC Health Plan payer ID 23281. Submit via Provider OnLine (POL); prior-auth forms at upmc.promptpa.com, Medical Management 1-800-425-7800. DME requires PA per UPMC''s auth list. Exact CHC paper-claims PO box not separately published — submit electronically via 23281 (UPMC general claims box PO Box 2999, Pittsburgh PA 15230).',
   180,
   NULL, NULL, NULL, NULL, NULL,
   '+18448609303', NULL,
   'portal', NULL, 5,
   ARRAY['KX']::text[], true, 'enrolled',
   'UPMC alphanumeric member ID',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('keystone_first_chc', 'Keystone First Community HealthChoices (PA Medicaid LTSS)',
   'Vista Health Plan, Inc.', 'AmeriHealth Caritas',
   'medicaid_mco', 'pa',
   '42344', '42344',
   '837p', false, true,
   '+18005216622', '+18005216007',
   'https://www.keystonefirstchc.com', NULL,
   'PA Medicaid Community HealthChoices (AmeriHealth Caritas / Vista Health Plan), primarily the Southeast zone. EDI payer ID 42344 (ERA uses ECHO payer ID 58379). Claims: PO Box 7146, London KY 40742-7146. Provider Services 1-800-521-6007; UM 1-800-521-6622 (fax 1-855-540-7066). Submit via NaviNet. DME monthly rentals require PA at any cost; purchases over $750 require PA. Timely filing 180 days initial (365 corrected; 60 COB).',
   180,
   'PO Box 7146', NULL, 'London', 'KY', '40742',
   '+18005216007', NULL,
   'portal', '+18555407066', 5,
   ARRAY['KX']::text[], true, 'pending',
   'PA Medicaid recipient ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('pa_health_wellness_chc', 'PA Health & Wellness Community HealthChoices (Medicaid LTSS)',
   'Pennsylvania Health & Wellness, Inc.', 'Centene Corporation',
   'medicaid_mco', 'pa',
   '68069', '68069',
   '837p', false, true,
   '+18446266813', '+18446266813',
   'https://www.pahealthwellness.com/providers.html', NULL,
   'PA Medicaid Community HealthChoices (Centene), statewide. Bills under Centene payer ID 68069 (Availity preferred; EDI team 1-800-225-2573). Provider Services 1-844-626-6813. DME purchases under $500 (with prescription) need no PA; rentals and items above $500 require PA via the Secure Provider Web Portal. NOTE: this is the PA Health & Wellness CHC line — the separate AmeriHealth Caritas PA CHC (payer ID 77062 / PO Box 7110 London KY) is a DIFFERENT plan. Exact CHC claims PO box not verified here — submit electronically via 68069.',
   180,
   NULL, NULL, NULL, NULL, NULL,
   '+18446266813', NULL,
   'portal', NULL, 5,
   ARRAY['KX']::text[], true, 'enrolled',
   'PA Medicaid recipient ID per card',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  -- ── Federal DME-relevant programs ──
  ('champva', 'CHAMPVA (VA — dependents/survivors)',
   'VHA Office of Integrated Veteran Care', 'U.S. Department of Veterans Affairs',
   'federal', 'national',
   '84146', '84146',
   '837p', false, true,
   '+18007338387', '+18007338387',
   'https://www.va.gov/COMMUNITYCARE/programs/dependents/champva', NULL,
   'Civilian Health and Medical Program of the VA — covers eligible dependents/survivors; ALWAYS secondary except to Medicaid/IHS. EDI payer ID 84146 via Change Healthcare. Claims: VHA Office of Integrated Veteran Care, ATTN: CHAMPVA Claims, PO Box 30750, Tampa FL 33630-3750. Phone 1-800-733-8387. Preauthorization required only for DME with a purchase OR total-rental price of $2,000 or more (CPAP/E0601 typically below that). Timely filing ~1 year from DOS. The claim number is the PATIENT''s SSN (not the veteran''s); the card shows a 10-digit Benefits ID.',
   365,
   'PO Box 30750', 'ATTN: CHAMPVA Claims', 'Tampa', 'FL', '33630',
   '+18007338387', NULL,
   'phone', NULL, NULL,
   ARRAY['KX','RR','NU']::text[], true, 'pending',
   'CHAMPVA 10-digit Benefits ID; claim # is the patient SSN',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('railroad_medicare', 'Railroad Medicare — Part B (Palmetto GBA)',
   'Palmetto GBA', 'Railroad Retirement Board / CMS',
   'medicare_part_b', 'national',
   '00882', '00882',
   '837p', false, false,
   NULL, '+18883559165',
   'https://www.palmettogba.com/rr', NULL,
   'Medicare Part B for Railroad Retirement beneficiaries (Palmetto GBA, the RRB Specialty MAC). EDI payer ID 00882; eServices/eClaims at PalmettoGBA.com/RR. Claims: PO Box 10066, Augusta GA 30999-0001. Provider Contact Center 1-888-355-9165. Timely filing 12 months. IMPORTANT: DME (CPAP/E0601, PAP supplies, oxygen) for a railroad beneficiary bills to the local DME MAC (Noridian Jurisdiction A in PA = the medicare_dme_noridian profile), NOT to Palmetto/00882 — this row is for Part B physician-jurisdiction services / crossover only.',
   365,
   'PO Box 10066', NULL, 'Augusta', 'GA', '30999',
   '+18883559165', NULL,
   'none', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Railroad Medicare MBI (11-character)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('tricare_for_life', 'TRICARE For Life (WPS)',
   'Wisconsin Physicians Service Insurance Corporation', 'Defense Health Agency',
   'federal', 'national',
   'TDFIC', 'TDFIC',
   '837p', false, false,
   NULL, '+18667730404',
   'https://www.tricare4u.com', NULL,
   'TRICARE For Life — Medicare-wraparound (secondary to Medicare) for military retirees 65+, administered by WPS. EDI payer ID TDFIC (do NOT use 99726, which is TRICARE West/TriWest). Claims: WPS TRICARE For Life, PO Box 7889, Madison WI 53707-7889. Phone 1-866-773-0404; EDI Help Desk 1-800-782-2680. Most claims auto-cross from Medicare (Medicare primary), so Medicare''s DME rules govern and TFL pays the wraparound. Timely filing 1 year.',
   365,
   'PO Box 7889', NULL, 'Madison', 'WI', '53707',
   '+18667730404', NULL,
   'none', NULL, NULL,
   ARRAY['KX','RR','NU']::text[], true, 'pending',
   'DoD Benefits Number / DoD ID number',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('federal_black_lung', 'Federal Black Lung Program (DOL DCMWC)',
   'Division of Coal Mine Workers'' Compensation (OWCP)', 'U.S. Department of Labor',
   'federal', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   '+18006387072', '+18006387072',
   'https://owcpmed.dol.gov', NULL,
   'Federal black-lung workers'' compensation for coal miners with pneumoconiosis (relevant in PA coal regions); pays oxygen/PAP/DME. Bills go through the DOL OWCP Medical Bill Processing Portal at owcpmed.dol.gov (OWCP-1500 via Direct Data Entry or a clearinghouse) — NOT Office Ally; providers must enroll for an OWCP Provider ID. Paper: U.S. Department of Labor OWCP/DCMWC, PO Box 8307, London KY 40742-8307. Call Center 1-800-638-7072. DME requires a Certificate of Medical Necessity (form CM-893). Bill must carry the patient 9-digit SSN + the 9-digit DCMWC provider number; modifiers NU (purchase) / RR (rental).',
   NULL,
   'PO Box 8307', NULL, 'London', 'KY', '40742',
   '+18006387072', NULL,
   'paper', NULL, NULL,
   ARRAY['NU','RR']::text[], false, 'not_applicable',
   'Patient SSN + 10-digit Black Lung Benefits ID',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  -- ── PA Medicare Advantage / D-SNP ──
  ('aetna_medicare_dsnp_pa', 'Aetna Medicare D-SNP (PA — Dual Eligible)',
   'Aetna Life Insurance Company', 'CVS Health',
   'medicare_advantage', 'multi_state',
   '60054', '60054',
   '837p', false, true,
   '+18664091221', '+18006240756',
   'https://www.availity.com', NULL,
   'Aetna Medicare Advantage Dual-Eligible SNP in PA (Medicare primary; cost-share crosses to PA Medicaid). EDI payer ID 60054. Claims: Aetna Medicare, PO Box 981106, El Paso TX 79998-1106. Provider Services 1-800-624-0756; UM 1-866-409-1221; submit PA via Availity. Do not balance-bill D-SNP members. Appeals to the PO box on the EOB/denial. Timely filing per the participation agreement.',
   365,
   'PO Box 981106', NULL, 'El Paso', 'TX', '79998',
   '+18006240756', NULL,
   'portal', NULL, 14,
   ARRAY['KX','RR','NU']::text[], true, 'enrolled',
   'Aetna alphanumeric member ID',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('cigna_preferred_medicare_pa', 'Cigna Preferred Medicare (PA Medicare Advantage / HealthSpring)',
   'Cigna Health and Life Insurance Company', 'The Cigna Group',
   'medicare_advantage', 'multi_state',
   '63092', '63092',
   '837p', false, true,
   '+18666864452', '+18002306138',
   'https://hsconnectonline.com', NULL,
   'Cigna Healthcare Medicare Advantage in PA (rebranded "HealthSpring" effective 2026-01-01). EDI payer ID 63092. Claims: Cigna Healthcare Medicare Advantage, PO Box 20002, Nashville TN 37202. Provider Services 1-800-230-6138; portal HSConnectOnline.com. DME prior auth via eviCore: 1-866-686-4452, fax 1-866-663-7740 (moving to Availity Essentials 2026-03-01). Timely filing 90 days in-network / 180 out-of-network.',
   90,
   'PO Box 20002', NULL, 'Nashville', 'TN', '37202',
   '+18002306138', NULL,
   'portal', '+18666637740', 14,
   ARRAY['KX','RR','NU']::text[], true, 'enrolled',
   'Cigna / HealthSpring alphanumeric member ID',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('highmark_community_blue_medicare', 'Highmark Community Blue Medicare HMO',
   'Highmark Inc.', 'Highmark Health',
   'medicare_advantage', 'pa',
   '54771', '54771',
   '837p', false, true,
   NULL, '+18009920246',
   'https://www.availity.com', NULL,
   'Highmark Medicare Advantage HMO (community-hospital network) in Western/Central/NE PA. Bills under the Highmark Blue Shield payer ID 54771 (the Community Blue MA on-card EDI id can differ by region — verify on the card / Availity). Highmark routes DME/respiratory/orthotics to PO Box 2718, Pittsburgh PA 15230. Submit PA via Availity per Highmark''s "Procedures/DME Requiring Authorization" list. EDI support 1-800-992-0246.',
   365,
   'PO Box 2718', NULL, 'Pittsburgh', 'PA', '15230',
   '+18009920246', NULL,
   'portal', NULL, 14,
   ARRAY['KX','RR','NU']::text[], true, 'enrolled',
   'Highmark 3-character alpha prefix + digits (BlueCard)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('upmc_for_life_dual', 'UPMC for Life Complete Care (HMO D-SNP)',
   'UPMC Health Plan, Inc.', 'UPMC',
   'medicare_advantage', 'pa',
   '23281', '23281',
   '837p', false, true,
   '+18004257800', '+18669181595',
   'https://www.upmchealthplan.com/providers', NULL,
   'UPMC for Life Complete Care HMO D-SNP (dual-eligible; CMS contract H4279). Bills under UPMC Health Plan payer ID 23281; submit via Provider OnLine (POL), prior-auth forms at upmc.promptpa.com, Medical Management 1-800-425-7800. Provider Services 1-866-918-1595. Exact MA paper-claims box not separately published — submit electronically via 23281.',
   180,
   NULL, NULL, NULL, NULL, NULL,
   '+18669181595', NULL,
   'portal', NULL, 14,
   ARRAY['KX','RR','NU']::text[], true, 'enrolled',
   'UPMC alphanumeric member ID',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  -- ── Commercial / TPA ──
  ('independence_administrators', 'Independence Administrators (IBX self-funded TPA)',
   'Independence Administrators', 'Independence Health Group',
   'commercial', 'multi_state',
   '54704', '54704',
   '837p', false, true,
   '+18883567899', '+18883567899',
   'https://www.ibxtpa.com/providers', NULL,
   'Self-funded (ASO/TPA) arm of Independence Blue Cross / AmeriHealth Administrators; BlueCard-networked. EDI payer ID 54704. Claims: Independence Administrators, c/o Processing Center, PO Box 21974, Eagan MN 55121. Provider Services 1-888-356-7899; prior auth via iEXCHANGE on ibxtpa.com. Claims for purchase/rental of medical equipment must include the physician''s medical certification. Timely filing varies by the employer plan.',
   NULL,
   'PO Box 21974', NULL, 'Eagan', 'MN', '55121',
   '+18883567899', NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'enrolled',
   '10-digit member ID (BlueCard alpha prefix)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('surest_uhc', 'Surest (a UnitedHealthcare plan)',
   'Bind Benefits, Inc. (d/b/a Surest)', 'UnitedHealth Group',
   'commercial', 'national',
   '25463', '25463',
   '837p', false, true,
   NULL, NULL,
   'https://www.uhcprovider.com/en/health-plans-by-state/surest.html', NULL,
   'Surest (formerly Bind), a UnitedHealthcare employer plan. EDI payer ID 25463 — claims sent under any other UHC payer ID are DENIED. Claims: Surest, PO Box 211758, Eagan MN 55121. Provider tools via UHCprovider.com / surest.com/providers. DME PA per Surest plan rules (UHC infrastructure). Timely filing per the provider agreement. Cards may still reference "Bind."',
   NULL,
   'PO Box 211758', NULL, 'Eagan', 'MN', '55121',
   NULL, NULL,
   'portal', NULL, NULL,
   ARRAY['KX']::text[], true, 'pending',
   'Surest member ID per card (may reference Bind)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  -- ── Auto no-fault / MedPay (PA MVFRL; adjuster/claim-number driven) ──
  ('progressive_auto', 'Progressive (Auto PIP / MedPay)',
   'Progressive Casualty Insurance Company', 'The Progressive Corporation',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18667497436',
   'https://www.progressive.com', NULL,
   'Auto first-party medical / PIP / MedPay (PA MVFRL; pays at the Act 6 cap = 110% of Medicare Part B). Office Ally does not clear auto — Progressive e-bills route via Availity under payer ID 24260 (attachment fax 877-213-7258, MedEDI@progressive.com); the 9-digit Progressive CLAIM NUMBER is required on every bill. No central medical-bills PO box — paper routes to the assigned adjuster. Claims 1-866-749-7436.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18667497436', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (9-digit, adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('allstate_auto', 'Allstate (Auto PIP / MedPay)',
   'Allstate Insurance Company', 'The Allstate Corporation',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18002557828',
   'https://www.allstate.com/claims', NULL,
   'Auto first-party medical / PIP / MedPay (PA MVFRL, Act 6 cap). Office Ally does not clear auto — Allstate auto-medical e-bills route via Jopari / Claim.MD under payer ID C1037 ("Allstate — except New Jersey"), keyed to the Allstate CLAIM NUMBER. No central PA medical-bills PO box (adjuster-routed). Claims 1-800-255-7828.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18002557828', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('nationwide_auto', 'Nationwide (Auto PIP / MedPay)',
   'Nationwide Mutual Insurance Company', 'Nationwide',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18004213535',
   'https://www.nationwide.com/personal/insurance/auto', NULL,
   'Auto first-party medical / PIP / MedPay (PA MVFRL, Act 6 cap). Office Ally does not clear auto — Nationwide e-bills route via WorkCompEDI / Data Dimensions under payer ID LV164 (covers Nationwide/Allied/Harleysville/Nationwide Agribusiness), keyed to the CLAIM NUMBER. No central medical-bills PO box (adjuster-routed). Claims 1-800-421-3535.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18004213535', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('geico_auto', 'GEICO (Auto PIP / MedPay)',
   'Government Employees Insurance Company', 'Berkshire Hathaway',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18008618380',
   'https://www.geico.com/information/aboutinsurance/auto/med-pay', NULL,
   'Auto first-party medical / PIP / MedPay (PA MVFRL, Act 6 cap). Office Ally does not clear auto — GEICO e-bills route via Jopari under payer ID J1747, keyed to the GEICO CLAIM NUMBER. General claims mail PO Box 9515, Fredericksburg VA 22403-9515 (NOT a DME-specific box — bills route to the adjuster). Claims 1-800-861-8380.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18008618380', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('usaa_auto', 'USAA (Auto PIP / MedPay)',
   'United Services Automobile Association', 'USAA',
   'other', 'national',
   NULL, NULL,
   'paper_1500', true, false,
   NULL, '+18005318722',
   'https://www.usaa.com/insurance/vehicles/auto', NULL,
   'Auto first-party medical / PIP / MedPay (PA MVFRL, Act 6 cap). USAA outsources PIP/medical-bill handling to Auto Injury Solutions (AIS). Office Ally does not clear auto — USAA e-bills route via Jopari / Claim.MD under payer ID J1822 (also listed as 74095), keyed to the USAA CLAIM NUMBER. No central PA medical-bills PO box (AIS/adjuster-routed). Claims 1-800-531-8722.',
   NULL,
   NULL, NULL, NULL, NULL, NULL,
   '+18005318722', NULL,
   'none', NULL, NULL,
   ARRAY[]::text[], false, 'not_applicable',
   'Auto claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  -- ── Workers' compensation (PA; Jopari/Carisk/Data Dimensions, not Office Ally) ──
  ('guard_insurance_wc', 'Berkshire Hathaway GUARD (Workers'' Compensation)',
   'Berkshire Hathaway GUARD Insurance Companies', 'Berkshire Hathaway',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18886392567',
   'https://www.guard.com/claims', NULL,
   'PA-domiciled workers''-comp carrier (HQ Wilkes-Barre PA). Office Ally does not clear WC — GUARD WC e-bills route via Jopari (exact Jopari payer ID assigned at enrollment, provider.jopari.net — UNVERIFIED here); medical management via GUARDCo. DME after a work injury is adjuster-authorized under the accepted claim, per the PA Workers'' Compensation Act fee schedule. Claims 1-888-639-2567.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18886392567', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('eastern_alliance_wc', 'Eastern Alliance Insurance (Workers'' Compensation)',
   'Eastern Alliance Insurance Group', 'ProAssurance',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18003363658',
   'https://www.easternalliance.com', NULL,
   'PA-based workers''-comp carrier (Lancaster PA; a ProAssurance company). Office Ally does not clear WC — Eastern Alliance WC e-bills route via Jopari / Claim.MD under payer ID J2143, keyed to the WC claim number. Claim Support / medical bills 1-800-336-3658 option 2. Mailing boxes PO Box 83777 and PO Box 14138 (Lancaster PA) appear — exact medical-bills box UNVERIFIED. DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18003363658', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('donegal_wc', 'Donegal Insurance Group (Workers'' Compensation)',
   'Donegal Mutual Insurance Company', 'Donegal Group Inc.',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18008779006',
   'https://www.donegalgroup.com/customer-services/claim-services', NULL,
   'PA-based workers''-comp carrier (HQ Marietta PA). Office Ally does not clear WC — Donegal WC medical bills route via a P&C clearinghouse (Jopari; exact payer ID assigned at enrollment — UNVERIFIED here), keyed to the WC claim number. No single published medical-bills PO box (adjuster-routed). Claims 1-800-877-9006. DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+18008779006', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('amerihealth_casualty_wc', 'AmeriHealth Casualty (Workers'' Compensation)',
   'AmeriHealth Casualty Services', 'Independence Health Group',
   'workers_comp', 'pa',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+18003355972',
   'https://www.amerihealthcasualty.com', NULL,
   'PA workers''-comp carrier (Philadelphia PA). Office Ally does not clear WC — supports e-billing via a P&C clearinghouse (Jopari; payer ID assigned at enrollment — UNVERIFIED here). Medical bills: AmeriHealth Casualty Services, PO Box 535370, Pittsburgh PA 15253-5370 (or email bills@AHCasualty.com). Report a claim 1-800-335-5972, claim fax 1-888-636-7725. DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   'PO Box 535370', NULL, 'Pittsburgh', 'PA', '15253',
   '+18003355972', '+18886367725',
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('chubb_wc', 'Chubb (Workers'' Compensation)',
   'Chubb Limited', 'Chubb',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, NULL,
   'https://www.chubb.com/us-en/claims/workers-compensation-claims-services.html', NULL,
   'National workers''-comp carrier (claims often administered by ESIS, Chubb''s TPA). Office Ally does not clear WC — Chubb WC e-bills route via Jopari under payer ID J1554, keyed to the WC claim number; bills can also be uploaded to the online claim. No single published medical-bills PO box — contact the assigned adjuster. DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('zurich_wc', 'Zurich North America (Workers'' Compensation)',
   'Zurich American Insurance Company', 'Zurich Insurance Group',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, '+17195908719',
   'https://www.zurichna.com/claims/medical-provider-billing-information', NULL,
   'National workers''-comp carrier. Office Ally does not clear WC — Jopari is Zurich''s designated WC e-bill clearinghouse in all states (exact Jopari payer ID assigned at enrollment — UNVERIFIED here; Jopari support 1-800-630-3060). Medical Provider Helpline 1-719-590-8719 (usz_carecenter@zurichna.com); status/EOR via the Jopari portal. DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   '+17195908719', NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210'),

  ('cna_wc', 'CNA (Workers'' Compensation)',
   'Continental Casualty Company', 'CNA Financial Corporation',
   'workers_comp', 'national',
   NULL, NULL,
   'paper_1500', true, true,
   NULL, NULL,
   'https://billing.cna.com', NULL,
   'National workers''-comp carrier. Office Ally does not clear WC — CNA WC e-bills route via Jopari (exact payer ID assigned at enrollment — UNVERIFIED here); CNA also operates a billing portal at billing.cna.com. No single published medical-bills PO box (adjuster-routed; use billing.cna.com). DME adjuster-authorized per the PA WC Act fee schedule.',
   365,
   NULL, NULL, NULL, NULL, NULL,
   NULL, NULL,
   'phone', NULL, 21,
   ARRAY[]::text[], false, 'not_applicable',
   'WC claim number (adjuster-assigned)',
   '2026-06-02T00:00:00Z', 'system:seed:0210')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- ──────────────────────────────────────────────────────────────────────
-- 2. COMPLETE — derive the jsonb / claim-logic 0142 columns for the new
--    rows from the flat data, scoped by the seed stamp. Guarded + idempotent
--    (mirrors 0206). 0206 precedes this file in replay order, so it does not
--    see these rows — we derive their second representation here.
-- ──────────────────────────────────────────────────────────────────────

-- 2a. jsonb claims_mailing_address ← flat claims address. Rows with no flat
--     address (UPMC CHC/Dual, PHW CHC, Surest, auto, most WC) are skipped.
UPDATE "resupply"."payer_profiles" SET
  "claims_mailing_address" = jsonb_strip_nulls(jsonb_build_object(
    'line1', "claims_address_line1",
    'line2', "claims_address_line2",
    'city',  "claims_city",
    'state', "claims_state",
    'zip',   "claims_zip"
  ))
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND "claims_mailing_address" IS NULL
  AND "claims_address_line1" IS NOT NULL
  AND "claims_city"  IS NOT NULL
  AND "claims_state" IS NOT NULL
  AND "claims_zip"   IS NOT NULL;
--> statement-breakpoint

-- 2b. Verified appeals addresses (Keystone First CHC clinical appeals; Cigna
--     Medicare Advantage appeals).
UPDATE "resupply"."payer_profiles" SET
  "appeals_mailing_address" =
    '{"line1":"PO Box 80111","city":"London","state":"KY","zip":"40742"}'::jsonb
WHERE "slug" = 'keystone_first_chc'
  AND "appeals_mailing_address" IS NULL;
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET
  "appeals_mailing_address" =
    '{"line1":"PO Box 188081","city":"Chattanooga","state":"TN","zip":"37422"}'::jsonb
WHERE "slug" = 'cigna_preferred_medicare_pa'
  AND "appeals_mailing_address" IS NULL;
--> statement-breakpoint

-- 2c. ERA payer id ← 5010 payer id (paper-only auto/WC/Black-Lung rows have a
--     NULL 5010 id → stay NULL).
UPDATE "resupply"."payer_profiles" SET
  "era_payer_id" = "edi_5010_payer_id"
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND "era_payer_id" IS NULL
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- 2d. ERA enrollment required for every row that bills electronically.
UPDATE "resupply"."payer_profiles" SET
  "era_enrollment_required" = true
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND "era_enrollment_required" = false
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- 2e. Claim-logic required_modifiers_dme ← admin required_claim_modifiers.
UPDATE "resupply"."payer_profiles" SET
  "required_modifiers_dme" = "required_claim_modifiers"
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND COALESCE(array_length("required_modifiers_dme", 1), 0) = 0
  AND COALESCE(array_length("required_claim_modifiers", 1), 0) > 0;
--> statement-breakpoint

-- 2f. Enrollment posture ← edi_enrollment_status (same mapping as 0206).
UPDATE "resupply"."payer_profiles" SET
  "enrollment_status" = CASE
    WHEN "edi_enrollment_status" = 'enrolled'       THEN 'active'
    WHEN "edi_enrollment_status" = 'pending'        THEN 'pending'
    WHEN "edi_enrollment_status" = 'not_applicable' THEN 'not_required'
    ELSE "enrollment_status"
  END
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND "enrollment_status" = 'unknown';
--> statement-breakpoint

-- 2g. Referring-provider-NPI requirement: true for the billable medical lines
--     (Medicaid CHC, MA, Medicare Part B, commercial, and the federal medical
--     plans CHAMPVA/TFL). The auto ('other') rows, WC rows, and the paper
--     Black Lung program stay false.
UPDATE "resupply"."payer_profiles" SET
  "requires_referring_provider_npi" = true
WHERE "requirements_last_verified_by" = 'system:seed:0210'
  AND "requires_referring_provider_npi" = false
  AND "line_of_business" IN ('medicaid_mco', 'medicare_advantage', 'medicare_part_b', 'commercial', 'federal')
  AND "slug" <> 'federal_black_lung';
--> statement-breakpoint
