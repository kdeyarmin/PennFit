-- 0207_payer_pa_pathways — annotate each payer profile with its
-- researched DME/PAP prior-authorization pathway so a CSR sees, on the
-- payer profile itself, HOW that payer takes a CPAP auth (portal +
-- specific form) without leaving the app.
--
-- Backed by per-payer research in docs/payer-prior-auth-pathways.md
-- (2026-06). Most payers take PA through a provider portal (Availity,
-- NaviNet, UPMC Provider OnLine, the UHC portal, EviCore/HealthSpring,
-- Cohere); a few mandate a specific PDF (PA Medicaid MA 97, PA Health &
-- Wellness PA-PAF-1138, Aetna Sleep Apnea Appliance form, Keystone First
-- PA Request Form). Medicare does NOT require PA for PAP (E0601 is not on
-- the CMS Required Prior Authorization List), and workers'-comp carriers
-- have no standard DME PA (adjuster-authorized).
--
-- We append a single tagged "[PA]" line to payer_profiles.notes (payer-
-- level metadata, never PHI — same contract as the existing notes). The
-- structured columns prior_auth_submission_method / provider_portal_url /
-- prior_auth_phone_e164 already carry the machine-readable version (set by
-- 0128/0149/0206); this is the human pathway the OA-CSV + admin drawer
-- surface verbatim.
--
-- Idempotent: each UPDATE only fires where notes doesn't already carry a
-- "[PA]" tag, so a re-run (or a from-scratch replay) is a no-op. notes is
-- never appended to twice.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ── Highmark commercial + Freedom Blue MA (Availity) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via Availity provider portal; capped-rental CPAP (E0601) requires PA. See Highmark "Procedures/DME Requiring Authorization" list + Medical Authorization Forms.'
WHERE slug IN ('highmark_bcbs_pa','highmark_bs_pa','highmark_medicare_advantage')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via NaviNet → GuidingCare (Highmark Wholecare Medicaid UM).'
WHERE slug = 'highmark_wholecare'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Independence Blue Cross + Keystone 65 / Personal Choice 65 + AmeriHealth PA/NJ (NaviNet/ProviderAccess) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] Precert via NaviNet / ProviderAccess Pre-Service Review; DME monthly rentals require precert regardless of cost.'
WHERE slug IN ('ibx','keystone_65','personal_choice_65','amerihealth_commercial')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Keystone First + AmeriHealth Caritas PA (NaviNet; payer PA Request Form PDF) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via NaviNet (Medical Authorizations → Workflows); CPAP rental requires PA at any cost (purchase >$750). Payer publishes a Prior Authorization Request Form (PDF).'
WHERE slug IN ('keystone_first','amerihealth_caritas_pa')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via Health Partners Plans provider portal / NaviNet.'
WHERE slug = 'health_partners_pa_medicaid'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── UPMC (Provider OnLine; CMN required) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via UPMC Provider OnLine; attach a Certificate of Medical Necessity (CMN). Medical Management 1-800-425-7800.'
WHERE slug IN ('upmc_health_plan','upmc_for_you','upmc_for_life')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Geisinger (NaviNet / Cohere) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via NaviNet / Cohere; PA required when the allowed amount exceeds $500 (CPAP qualifies). Care connector 1-888-839-7972.'
WHERE slug IN ('geisinger_health_plan','geisinger_gold','geisinger_health_plan_family')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Capital BlueCross (NaviNet) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via the Capital BlueCross provider portal (NaviNet).'
WHERE slug IN ('capital_bc','capital_blue_senior')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── PEBTF (PA state-employee trust; medical administered by Capital BlueCross) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DME PA via the Capital BlueCross provider portal (NaviNet) — PEBTF medical is administered by Capital BlueCross.'
WHERE slug = 'pebtf'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Aetna / CVS Health (Availity) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via Availity; CPAP per Aetna Participating Provider Precertification List. (Aetna "Sleep Apnea Appliance" precert form is for oral appliances, not CPAP.) Non-Medicare precert 1-800-624-0756.'
WHERE slug IN ('aetna_commercial','aetna_medicare_pa')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via Availity (Aetna Better Health Kids / PA CHIP).'
WHERE slug = 'aetna_better_health_kids_pa'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via Availity per the self-funded group rules (Meritain is an Aetna TPA).'
WHERE slug = 'meritain_health'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via Availity (PSERS HOP is administered by Aetna).'
WHERE slug = 'psers_hop'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Cigna (EviCore / HealthSpring) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] Commercial PAP device = registration via EviCore (not full precert); DME PA moving EviCore → HealthSpring 2026-03-01. Eligibility via CignaforHCP. EviCore 1-800-298-4806.'
WHERE slug = 'cigna_commercial'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via EviCore / CignaforHCP (Cigna Healthcare Medicare).'
WHERE slug = 'cigna_medicare_pa'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── UnitedHealthcare / Optum (UHC Provider Portal) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via the UnitedHealthcare Provider Portal "Prior Authorization and Notification" tool (check member first for a Decision ID). Provider Services 1-877-842-3210, fax 1-855-352-1206.'
WHERE slug IN ('uhc_commercial','uhc_community_plan_pa','uhc_dual_complete_pa')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via umr.com provider Prior Authorization, per the self-funded group (UMR is a UHC TPA).'
WHERE slug = 'umr'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] No PA — Medicare Supplement (Medigap) pays the 20% coinsurance by crossover after Medicare adjudicates.'
WHERE slug = 'aarp_uhc_medsup'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Humana (Availity) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via Availity (use Humana''s PA search tool to confirm); decisions within ~72 hours.'
WHERE slug IN ('humana_commercial','humana_gold_plus_pa')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Centene (PA Health & Wellness PA-PAF-1138; Wellcare portal) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via the Secure Provider Web Portal; specific form PA-PAF-1138 (Outpatient Medicaid PA). CPAP supplies limited to 1 every 5 years. 1-844-626-6813.'
WHERE slug = 'pa_health_and_wellness'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via the Wellcare provider portal (provider.wellcare.com).'
WHERE slug = 'wellcare_pa'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Regional MA (Devoted, Clover) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via the Devoted provider portal (provider.devoted.com) — confirm current DME medical policy.'
WHERE slug = 'devoted_health_pa'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via the Clover provider portal — confirm current DME medical policy.'
WHERE slug = 'clover_health_pa'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── PA Medicaid FFS (PROMISe; MA 97) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] PA via PROMISe; specific form MA 97 (Outpatient Services Authorization Request). Use the 1150 Administrative Waiver / Program Exception to exceed program limits.'
WHERE slug = 'pa_medicaid_ffs'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── PA CHIP umbrella ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] Bill the contracted CHIP MCO and follow that MCO''s PA pathway.'
WHERE slug = 'pa_chip'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Federal (TRICARE East, VA CCN) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] DMEPOS authorization via the Humana Military provider portal; a CMN / physician order must accompany the claim (an approved auth does not replace it).'
WHERE slug = 'tricare_east'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] Referral/authorization required for essentially all CCN care via Optum; CCN will not pay a DME rental beyond 30 days without a Request for Service (RFS) back to the VA.'
WHERE slug = 'va_ccn_region1'
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Medicare (no PA for PAP) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] No PA for PAP — E0601 is not on the CMS Required Prior Authorization List; coverage is documentation-driven (LCD L33718: face-to-face, qualifying sleep study, 31-91 day adherence re-eval).'
WHERE slug IN ('medicare_pa_novitas','medicare_dme_noridian')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint

-- ── Workers' compensation (no standard DME PA) ──
UPDATE "resupply"."payer_profiles" SET notes = COALESCE(notes,'')
  || E'\n[PA] No standard DME PA — authorization is via the claims adjuster under the accepted WC claim; bill via Jopari WC EDI or paper HCFA-1500.'
WHERE slug IN ('swif_pa_wc','pma_companies_wc','erie_insurance_pa','liberty_mutual_wc','travelers_wc','the_hartford_wc','sedgwick_cms')
  AND COALESCE(notes,'') NOT LIKE '%[PA]%';
--> statement-breakpoint
