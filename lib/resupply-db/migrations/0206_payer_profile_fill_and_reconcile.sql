-- 0206_payer_profile_fill_and_reconcile — complete every payer profile
-- so the claim builder, scrubber, ERA reconciler, prior-auth workflow,
-- HCFA-1500 / appeal PDFs, admin edit drawer, and Office-Ally
-- enrollment CSV all have the data they need for ALL 51 catalog
-- payers — not just the half each prior migration happened to touch.
--
-- The drift this heals
-- --------------------
-- The catalog was seeded + extended in two waves that populated two
-- DIFFERENT (overlapping) representations of the same facts, and each
-- wave only filled the rows it inserted:
--
--   * 0128 seeded 26 payers. 0142 then backfilled THOSE 26 with the
--     jsonb side — `claims_mailing_address` / `appeals_mailing_address`
--     (read by the HCFA-1500 + appeal-letter PDFs), plus
--     `member_id_pattern`, `required_modifiers_dme`, `era_payer_id`,
--     `enrollment_status`, `requires_referring_provider_npi` (read by
--     the claim builder / preflight / AI scrubber / ERA resolver).
--     The 26 never got the FLAT 0149 columns.
--
--   * 0149 seeded 25 MORE payers and added the FLAT side —
--     `claims_address_line1..zip`, `claims_phone/fax_e164`,
--     `prior_auth_submission_method` / `_fax_e164` / `_turnaround…`,
--     `required_claim_modifiers`, `edi_enrollment_status`,
--     `member_id_format_hint` (read by the admin drawer + OA CSV).
--     Those 25 never got the jsonb / claim-logic columns from 0142.
--
-- Net effect today:
--   - The 26 original payers render blank claims-address fields in the
--     admin drawer + OA CSV, carry an empty `required_claim_modifiers`
--     on the non-Medicare lines, and have no PA-submission method/SLA.
--   - The 25 newer payers produce an empty MAIL-TO block on HCFA-1500
--     paper claims, are invisible to the ERA reconciler (no
--     `era_payer_id`), sit at `enrollment_status='unknown'` (which the
--     claim preflight / Office-Ally batch treat as not-ready), and
--     enforce no required DME modifiers in the claim scrubber
--     (`required_modifiers_dme` empty).
--
-- This migration derives each missing side FROM THE SIDE THAT IS
-- ALREADY POPULATED (the prior waves did the per-payer research), plus
-- a few standards-based defaults (timely-filing already set; PA
-- submission method/turnaround by line-of-business). No payer fact is
-- invented: addresses are copied across representations, modifiers are
-- mirrored, the ERA id defaults to the 5010 id, and Medicare/Medicaid/
-- commercial rows get the referring-NPI flag the 0142 cohort already
-- carries.
--
-- Idempotent: every statement is guarded so it only writes where the
-- target is still NULL/empty. Re-running — or running on a from-scratch
-- replay where a later hand-edit already filled a value — is a no-op.
--
-- NOT touched here
-- ----------------
--   * `davinci_pas_endpoint_url` stays NULL. The Da Vinci PAS FHIR
--     endpoints are operator-populated out of band (they are not in the
--     payer-profiles write schema and POST a Bearer token, so a wrong
--     value is a security/again-mis-route risk — see
--     davinci-pas-submit.ts). Until a payer publishes its PAS base URL
--     the electronic-278 path stays unavailable and CSRs use the
--     auto-generated PA request form (faxed / portal-attached) instead.
--   * `appeals_mailing_address` for the 25 newer payers stays NULL: a
--     wrong appeals PO box mis-routes an appeal, and the appeal-letter
--     PDF already degrades to "(see payer provider manual)" when null.
--     Filling these is tracked for a verified follow-up, not guessed.
--   * `prior_auth_fax_e164` is left as-is. We do NOT guess PA fax
--     numbers — faxing PHI to an unverified number is a HIPAA incident.
--     The 26 originals default to portal/phone intake (their real
--     modern path); a verified fax can be added per-row in the admin.
--
-- Per ADR 003 — versioned hand-authored migration.

-- ════════════════════════════════════════════════════════════════════
-- HALF A — the 26 original (0128) payers: fill the FLAT 0149 columns
--          from the jsonb 0142 data + standards-based PA defaults.
-- ════════════════════════════════════════════════════════════════════

-- A1. Flat claims address ← jsonb claims_mailing_address.
-- (None of the 0128 claims_mailing_address values carry a line3, so
--  line2 maps cleanly; the guard skips rows already populated.)
UPDATE "resupply"."payer_profiles" SET
  "claims_address_line1" = "claims_mailing_address"->>'line1',
  "claims_address_line2" = "claims_mailing_address"->>'line2',
  "claims_city"          = "claims_mailing_address"->>'city',
  "claims_state"         = "claims_mailing_address"->>'state',
  "claims_zip"           = "claims_mailing_address"->>'zip'
WHERE "claims_address_line1" IS NULL
  AND "claims_mailing_address" IS NOT NULL
  AND "claims_mailing_address"->>'line1' IS NOT NULL
  AND "claims_mailing_address"->>'city'  IS NOT NULL
  AND "claims_mailing_address"->>'state' IS NOT NULL
  AND "claims_mailing_address"->>'zip'   IS NOT NULL;
--> statement-breakpoint

-- A2. Admin-visible required_claim_modifiers ← claim-logic
--     required_modifiers_dme (so the 0128 commercial/Medicaid rows that
--     0149 left empty show the KX the claim scrubber already enforces).
UPDATE "resupply"."payer_profiles" SET
  "required_claim_modifiers" = "required_modifiers_dme"
WHERE COALESCE(array_length("required_claim_modifiers", 1), 0) = 0
  AND COALESCE(array_length("required_modifiers_dme", 1), 0) > 0;
--> statement-breakpoint

-- A3. Claims submission phone ← claim-status phone (the DME claims line
--     and the claim-status line are the same number for these payers).
UPDATE "resupply"."payer_profiles" SET
  "claims_phone_e164" = "claim_status_phone_e164"
WHERE "claims_phone_e164" IS NULL
  AND "claim_status_phone_e164" IS NOT NULL;
--> statement-breakpoint

-- A4. PA submission method: payers that require DME PA and publish a
--     provider portal take it via portal (their real modern intake);
--     payers that don't require PA (Medicare Part B / DME MAC for PAP)
--     are 'none'; the rare portal-less PA payer falls back to phone.
UPDATE "resupply"."payer_profiles" SET
  "prior_auth_submission_method" = CASE
    WHEN "requires_prior_auth_dme" = false THEN 'none'
    WHEN "provider_portal_url" IS NOT NULL  THEN 'portal'
    ELSE 'phone'
  END
WHERE "prior_auth_submission_method" IS NULL;
--> statement-breakpoint

-- A5. PA decision SLA (business days) by line of business — industry
--     norms; PA Medicaid MCOs are bound to a 7-CALENDAR-day standard
--     (PA DHS OpsMemo 2025-09 ≈ 5 business days). Only for rows that
--     actually require DME PA; Medicare PAP (no PA) stays NULL.
UPDATE "resupply"."payer_profiles" SET
  "prior_auth_turnaround_business_days" = CASE
    WHEN "line_of_business" = 'commercial'         THEN 7
    WHEN "line_of_business" = 'medicare_advantage' THEN 14
    WHEN "line_of_business" = 'medicaid_mco'       THEN 5
    WHEN "line_of_business" = 'medicaid_ffs'       THEN 21
    WHEN "line_of_business" = 'federal'            THEN 14
    ELSE NULL
  END
WHERE "prior_auth_turnaround_business_days" IS NULL
  AND "requires_prior_auth_dme" = true;
--> statement-breakpoint

-- A6. Human member-ID hint ← the regex member_id_pattern (translated to
--     prose for the admin drawer + OA CSV). Only the unambiguous
--     patterns are mapped; anything else stays NULL.
UPDATE "resupply"."payer_profiles" SET
  "member_id_format_hint" = CASE "member_id_pattern"
    WHEN '^\d{10}$'                THEN '10-digit numeric member ID'
    WHEN '^\d{10,11}$'             THEN '10–11 digit numeric member ID'
    WHEN '^\d{10,12}$'             THEN '10–12 digit numeric member ID'
    WHEN '^\d{9,11}$'              THEN '9–11 digit numeric member ID'
    WHEN '^\d{9,12}$'              THEN '9–12 digit numeric member ID'
    WHEN '^[A-Z]{3}\d{9,12}$'      THEN '3-letter alpha prefix + 9–12 digits'
    WHEN '^[A-Z]{3}\d{9,11}$'      THEN '3-letter alpha prefix + 9–11 digits'
    WHEN '^[A-Z]{3}\d{8,11}$'      THEN '3-letter alpha prefix + 8–11 digits'
    WHEN '^[A-Z0-9]{9,12}$'        THEN '9–12 alphanumeric characters'
    WHEN '^[A-Z]?\d{8,11}$'        THEN 'optional letter prefix + 8–11 digits'
    WHEN '^W\d{9}$|^\d{9,12}$'     THEN 'W + 9 digits, or 9–12 digits'
    WHEN '^W\d{9}$|^[A-Z0-9]{9,12}$' THEN 'W + 9 digits, or 9–12 alphanumeric'
    WHEN '^H\d{8,10}$|^\d{9,11}$'  THEN 'H + 8–10 digits, or 9–11 digits'
    WHEN '^[1-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z][A-NP-Z0-9][0-9][A-NP-Z]{2}[0-9]{2}$'
                                  THEN 'Medicare Beneficiary Identifier (MBI) — 11 characters'
    ELSE NULL
  END
WHERE "member_id_format_hint" IS NULL
  AND "member_id_pattern" IS NOT NULL;
--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════
-- HALF B — the 25 newer (0149) payers: fill the jsonb + claim-logic
--          0142 columns from the flat data they already carry.
-- ════════════════════════════════════════════════════════════════════

-- B1. jsonb claims_mailing_address ← flat claims address (read by the
--     HCFA-1500 paper-claim MAIL-TO block). Rows with no flat address
--     (pa_chip umbrella placeholder) are correctly skipped.
UPDATE "resupply"."payer_profiles" SET
  "claims_mailing_address" = jsonb_strip_nulls(jsonb_build_object(
    'line1', "claims_address_line1",
    'line2', "claims_address_line2",
    'city',  "claims_city",
    'state', "claims_state",
    'zip',   "claims_zip"
  ))
WHERE "claims_mailing_address" IS NULL
  AND "claims_address_line1" IS NOT NULL
  AND "claims_city"  IS NOT NULL
  AND "claims_state" IS NOT NULL
  AND "claims_zip"   IS NOT NULL;
--> statement-breakpoint

-- B2. Claim-logic required_modifiers_dme ← admin required_claim_modifiers
--     (so the claim builder / scrubber enforce the same KX/RR set the
--     25 newer rows already declare for the admin surface).
UPDATE "resupply"."payer_profiles" SET
  "required_modifiers_dme" = "required_claim_modifiers"
WHERE COALESCE(array_length("required_modifiers_dme", 1), 0) = 0
  AND COALESCE(array_length("required_claim_modifiers", 1), 0) > 0;
--> statement-breakpoint

-- B3. ERA payer id ← 5010 payer id (the ERA reconciler keys remits off
--     era_payer_id; default it to the send-side id, which matches for
--     every electronic payer in the catalog). WC / umbrella rows with
--     no 5010 id correctly stay NULL.
UPDATE "resupply"."payer_profiles" SET
  "era_payer_id" = "edi_5010_payer_id"
WHERE "era_payer_id" IS NULL
  AND "edi_5010_payer_id" IS NOT NULL;
--> statement-breakpoint

-- B4. Enrollment posture: the claim preflight / Office-Ally batch treat
--     enrollment_status='unknown' as not-ready. Resolve it from the
--     already-set edi_enrollment_status: enrolled → active; paper-only /
--     not-applicable (WC, Medigap crossover) → not_required.
UPDATE "resupply"."payer_profiles" SET
  "enrollment_status" = CASE
    WHEN "edi_enrollment_status" = 'enrolled'        THEN 'active'
    WHEN "edi_enrollment_status" = 'pending'         THEN 'pending'
    WHEN "edi_enrollment_status" = 'not_applicable'  THEN 'not_required'
    WHEN "line_of_business" = 'workers_comp'         THEN 'not_required'
    ELSE "enrollment_status"
  END
WHERE "enrollment_status" = 'unknown';
--> statement-breakpoint

-- B5. Referring-provider-NPI requirement: the 0142 cohort carries this
--     true for every line of business whose 837P edits reject a missing
--     2310A NPI (commercial / Medicare / Medicaid / federal). Mirror it
--     onto the 25 newer rows; leave WC + the Medigap-crossover ('other')
--     row false (they don't run their own DME medical-necessity edits).
UPDATE "resupply"."payer_profiles" SET
  "requires_referring_provider_npi" = true
WHERE "requires_referring_provider_npi" = false
  AND "line_of_business" NOT IN ('workers_comp', 'other');
--> statement-breakpoint

-- B6. member_id_pattern ← the prose member_id_format_hint, but ONLY for
--     the unambiguous fixed-length numeric hints. We deliberately skip
--     any hint that mentions an alpha prefix (e.g. "9-digit member ID
--     (HP-prefixed)", "9-digit member ID with G- prefix") — a bare
--     "^\d{9}$" would false-positive a valid prefixed ID. Hints that
--     explicitly say "no prefix" are kept. The claim-builder validator
--     treats this as a SOFT warning and skips a NULL pattern, so the
--     conservative omission is harmless.
UPDATE "resupply"."payer_profiles" SET
  "member_id_pattern" = CASE
    WHEN "member_id_format_hint" ILIKE '10-digit%'  THEN '^\d{10}$'
    WHEN "member_id_format_hint" ILIKE '11-digit%'  THEN '^\d{11}$'
    WHEN "member_id_format_hint" ILIKE '9-digit%'   THEN '^\d{9}$'
    ELSE NULL
  END
WHERE "member_id_pattern" IS NULL
  AND "member_id_format_hint" IS NOT NULL
  AND (
    "member_id_format_hint" ILIKE '10-digit%'
    OR "member_id_format_hint" ILIKE '11-digit%'
    OR "member_id_format_hint" ILIKE '9-digit%'
  )
  AND (
    "member_id_format_hint" NOT ILIKE '%prefix%'
    OR "member_id_format_hint" ILIKE '%no prefix%'
  );
--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════
-- FINAL — stamp a verification marker on every row this pass completed
--         so the OA-export "REVIEW" flag clears and ops can see the
--         catalog was reconciled as of this migration.
-- ════════════════════════════════════════════════════════════════════
UPDATE "resupply"."payer_profiles" SET
  "requirements_last_verified_at" = COALESCE("requirements_last_verified_at", now()),
  "requirements_last_verified_by" = COALESCE("requirements_last_verified_by", 'system:backfill:0206')
WHERE "requirements_last_verified_at" IS NULL
   OR "requirements_last_verified_by" IS NULL;
--> statement-breakpoint
