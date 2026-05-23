-- 0156 — drop HIPAA / DMEPOS / ACHC compliance machinery
--
-- The eleven compliance domains the resupply program previously
-- tracked have been retired at the user's direction. This migration
-- drops every table that fronted those domains.
--
-- DATA-LOSS WARNING
-- -----------------
-- Every table dropped here may contain rows that are individually
-- required to be retained for six years under HIPAA §164.530(j).
-- The application code that wrote those rows has been deleted; this
-- migration removes the storage. Anyone running this in production
-- must have an out-of-band export already in hand. The teardown was
-- approved at session-level — this is the migration-level note.
--
-- Domains dropped (and the surface that fronted them):
--
--   1. HIPAA §164.312(b) tamper-evident audit chain
--        - audit_log (full table, not just the HMAC columns)
--   2. HIPAA §164.504(e) Business Associate Agreement inventory
--        - business_associate_agreements
--   3. DMEPOS staff policy attestation
--        - accreditation_policies
--        - admin_policy_attestations
--   4. HIPAA §164.308(a)(5) staff training records
--        - staff_training_records
--   5. CMS §424.57(c)(11) patient grievance tracking
--        - patient_grievances
--   6. HIPAA §164.308(a)(3) OIG LEIE screening
--        - oig_leie_exclusions
--        - oig_leie_screenings
--   7. HIPAA §164.522/.524/.526/.528 patient rights requests
--        - patient_rights_requests
--   8. HIPAA §164.528 patient disclosure accounting
--        - patient_disclosure_log
--   9. HIPAA §164.308(a)(7) contingency plan + drills
--        - contingency_plan_attestations
--        - disaster_preparedness_drills
--  10. ACHC QAPI quality-improvement program
--        - quality_improvement_initiatives
--        - quality_improvement_measurements
--  11. 42 CFR §424.57(c)(17) DME ownership/control disclosure
--        - dme_ownership_disclosures
--
-- And the cross-cutting infrastructure those eleven leaned on:
--   - hipaa_risk_assessments    (§164.308(a)(1)(ii)(A) annual analysis)
--   - hipaa_breach_incidents    (§164.404–.414 breach lifecycle)
--   - accreditation_surveys     (scheduled / completed CMS visits)
--   - accreditation_readiness_runs + accreditation_readiness_findings
--     (the rule-engine output that drove the deleted /admin/
--      accreditation/readiness route)
--
-- Drop order respects every foreign-key relationship in the schema,
-- but each statement uses IF EXISTS + CASCADE so a partial state
-- (rerun, manual intervention) still completes cleanly.

-- Child tables first (where ON DELETE RESTRICT would otherwise block).

DROP TABLE IF EXISTS "resupply"."admin_policy_attestations" CASCADE;
DROP TABLE IF EXISTS "resupply"."accreditation_policies" CASCADE;

DROP TABLE IF EXISTS "resupply"."quality_improvement_measurements" CASCADE;
DROP TABLE IF EXISTS "resupply"."quality_improvement_initiatives" CASCADE;

DROP TABLE IF EXISTS "resupply"."accreditation_readiness_findings" CASCADE;
DROP TABLE IF EXISTS "resupply"."accreditation_readiness_runs" CASCADE;
DROP TABLE IF EXISTS "resupply"."accreditation_surveys" CASCADE;

DROP TABLE IF EXISTS "resupply"."oig_leie_screenings" CASCADE;
DROP TABLE IF EXISTS "resupply"."business_associate_agreements" CASCADE;
DROP TABLE IF EXISTS "resupply"."oig_leie_exclusions" CASCADE;

DROP TABLE IF EXISTS "resupply"."staff_training_records" CASCADE;
DROP TABLE IF EXISTS "resupply"."patient_grievances" CASCADE;
DROP TABLE IF EXISTS "resupply"."patient_rights_requests" CASCADE;
DROP TABLE IF EXISTS "resupply"."patient_disclosure_log" CASCADE;

DROP TABLE IF EXISTS "resupply"."hipaa_risk_assessments" CASCADE;
DROP TABLE IF EXISTS "resupply"."hipaa_breach_incidents" CASCADE;
DROP TABLE IF EXISTS "resupply"."contingency_plan_attestations" CASCADE;
DROP TABLE IF EXISTS "resupply"."disaster_preparedness_drills" CASCADE;
DROP TABLE IF EXISTS "resupply"."dme_ownership_disclosures" CASCADE;

-- Finally, the general audit_log table itself. The HMAC tamper-
-- evidence chain (chain_seq / prev_signature / signature columns
-- added in migration 0116, archived_at + index added in 0101) goes
-- with it — DROP TABLE removes every column, index, and check
-- constraint in one step.

DROP TABLE IF EXISTS "resupply"."audit_log" CASCADE;
