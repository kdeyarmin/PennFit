# Compliance mapping — 2026-05-19

Cross-reference between each external compliance requirement and the
code / data artifact that implements it. This document is the
"source of truth" the next surveyor (ACHC, BOC, Medicare PSA, OIG)
should walk through. Every row points at a specific table, route,
migration, or service module — no narrative without a citation.

The work in scope on this branch closed the eight gaps identified by
the May 2026 regulatory + code audit:

1. HIPAA Business Associate Agreement inventory (§164.504(e))
2. OIG LEIE monthly exclusion screening
3. Patient rights workflow (§164.522 / .524 / .526 / .528)
4. Accounting of disclosures (§164.528)
5. Annual HIPAA security risk assessment (§164.308(a)(1)(ii)(A))
6. Contingency plan + disaster preparedness drills (§164.308(a)(7))
7. ACHC QAPI quality-improvement program
8. DMEPOS ownership / managing-control disclosure (42 CFR §424.57(c)(17))

---

## HIPAA Privacy Rule — 45 CFR Part 164 Subpart E

| Citation                | Requirement                              | Where implemented                                                                                                                                              |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §164.502(e), §164.504(e) | Written BAA with every business associate before PHI disclosure | `resupply.business_associate_agreements` (mig 0141), `/admin/compliance/business-associate-agreements/*` routes, status + expiry buckets surfaced on dashboard |
| §164.520                | Notice of Privacy Practices              | `accreditation_policies` (mig 0118 / 0119) `notice_of_privacy_practices` policy slug + per-patient attestation in `patient_form_acknowledgements`              |
| §164.522(a)             | Right to request restrictions on use/disclosure | `patient_rights_requests` with `request_kind='restriction'` (mig 0141)                                                                                          |
| §164.522(b)             | Right to receive confidential communications | `patient_rights_requests` with `request_kind='confidential_communications'`                                                                                     |
| §164.524                | Right of access to designated record set, 30-day clock + single 30-day extension | `patient_rights_requests` with `request_kind='access'`; `lib/compliance/patient-rights-clock.ts` enforces the 30/60-day buckets                                  |
| §164.526                | Right to amendment                       | `patient_rights_requests` with `request_kind='amendment'`; `request_details_json` carries `{record_table, record_id, proposed_value}`                            |
| §164.528                | Right to an accounting of disclosures (6-year window, non-TPO) | `patient_disclosure_log` (mig 0141); admin write at `/admin/compliance/disclosure-log` + patient read at `/api/me/disclosures`; `lib/compliance/disclosure-logger.ts` enforces the 6-year cap |
| §164.530(c)             | Administrative, technical, physical safeguards | Implemented across the codebase; representative checks: `lib/compliance/training-expiry.ts`, `lib/auth-deps.ts`, audit-log HMAC chain (mig 0116)              |

## HIPAA Security Rule — 45 CFR Part 164 Subpart C

| Citation                       | Requirement                                                          | Where implemented                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| §164.308(a)(1)(ii)(A)          | Risk analysis (annual)                                               | `resupply.hipaa_risk_assessments` (mig 0141) with UNIQUE on `assessment_year`; `/admin/compliance/risk-assessments` CRUD                       |
| §164.308(a)(1)(ii)(B)          | Risk management (corrective actions)                                 | `remediation_plan` text column on `hipaa_risk_assessments`                                                                                   |
| §164.308(a)(3)                 | Workforce clearance procedures (screening before access)             | `resupply.oig_leie_screenings` (mig 0141); admin-side at `/admin/compliance/oig-leie-screenings/*`; monthly auto-refresh worker `oig-leie-sync` |
| §164.308(a)(5)                 | Security awareness + training                                        | `resupply.staff_training_records` (mig pre-0141), `lib/compliance/training-expiry.ts` for expiry buckets                                       |
| §164.308(a)(6)                 | Security incident procedures                                         | `resupply.hipaa_breach_incidents` (mig 0139); admin at `/admin/hipaa-breach-incidents`                                                       |
| §164.308(a)(7)                 | Contingency plan + disaster recovery                                 | `resupply.contingency_plan_attestations` + `resupply.disaster_preparedness_drills` (mig 0141); admin at `/admin/compliance/contingency-attestations`, `.../disaster-drills` |
| §164.308(a)(8)                 | Evaluation (periodic)                                                | `hipaa_risk_assessments` `methodology='internal'` rows; ACHC QAPI program in `quality_improvement_initiatives`                                |
| §164.312(a)(2)(i)              | Unique user identification                                           | `resupply_auth.users.id` UUID; `admin_users` PK; in-house argon2id auth (no shared accounts)                                                  |
| §164.312(b)                    | Audit controls (tamper-evident audit log)                            | `resupply.audit_log` HMAC-SHA256 chain (mig 0116); `lib/resupply-audit` package                                                              |
| §164.312(c)(1)                 | Integrity controls                                                   | Audit-log chain (above) + Postgres column-level constraints throughout                                                                       |
| §164.312(e)                    | Transmission security (TLS in flight)                                | All HTTP terminations enforce TLS; outbound SFTP via system `sftp` binary with host-key pinning                                              |

## HIPAA Breach Notification — 45 CFR Part 164 Subpart D

| Citation              | Requirement                                          | Where implemented                                                                                            |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| §164.402              | Definition + risk-of-compromise assessment           | `hipaa_breach_incidents.risk_of_compromise_assessment` jsonb column (mig 0139)                                |
| §164.404              | Patient notification, 60-day clock                   | `hipaa_breach_incidents.patient_notification_sent_at` + due-date bucketization in the admin UI               |
| §164.406              | Media notification (>500 PA residents)               | `hipaa_breach_incidents.media_notice_required` boolean + `media_notice_sent_at`                              |
| §164.408              | HHS Secretary notification                           | `hhs_notice_sent_at` column; 60-day for ≥500-record breaches, annual roll-up otherwise                       |

## 2025 HIPAA Security Rule NPRM (anticipated)

| Anticipated requirement                                           | Where implemented                                                                                                                |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Annual written verification of BA safeguards                       | `business_associate_agreements.last_safeguard_attestation_on` date column                                                         |
| 72-hour critical-system recovery SLA                              | `contingency_plan_attestations.documented_rto_hours` (default 72)                                                                |
| MFA for systems with PHI access                                   | `resupply.admin_mfa_secrets` (mig 0114); enrollment + sign-in gating via `/admin/mfa`                                            |

## CMS DMEPOS Supplier Standards — 42 CFR §424.57(c)

| Standard #              | Requirement                                                              | Where implemented                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| (c)(1)                  | Operates business in accordance with federal/state/local regulations     | `accreditation_policies` catalog covers the policy set; `admin_policy_attestations` proves staff acknowledgement                          |
| (c)(2)                  | Files all required claims                                                | `insurance_claims` + `insurance_claim_events` + Office Ally 837P submission (lib/billing/office-ally-submission.ts)                       |
| (c)(3)                  | Delivers items only with a valid order                                   | DWO/CMN/SWO workflow in `dwo_documents` (mig 0134) + dispense-readiness review (mig 0140 / Phase 9)                                      |
| (c)(4)                  | Beneficiary refund procedures                                            | `shop_returns` + `claim_appeals` + `billing_statements` refund-row support                                                              |
| (c)(7)                  | Maintain a physical facility                                              | `dme_organization` row carries the registered address                                                                                   |
| (c)(8)                  | Permits CMS to conduct site visits                                       | `accreditation_surveys` table (mig 0119)                                                                                                |
| (c)(9)                  | Liability insurance ($300k)                                              | `dme_organization.liability_insurance_*` columns                                                                                        |
| (c)(11)                 | Beneficiary complaint resolution                                          | `patient_grievances` (mig 0118), state machine in `lib/compliance/training-expiry.ts:isLegalGrievanceTransition`                          |
| (c)(15)                 | Pickup/replacement of defective items                                    | `shop_returns` linear lifecycle + `equipment_recalls` + `recall_remediation_actions`                                                    |
| (c)(17)                 | Disclose ownership / managing-control persons                            | `resupply.dme_ownership_disclosures` (mig 0141); admin at `/admin/compliance/ownership-disclosures`                                     |
| (c)(22)                 | Provide Medicare Supplier Standards document                             | `accreditation_policies` slug `medicare_supplier_standards` + `patient_form_acknowledgements`                                          |
| (c)(26)                 | Surety bond ($50k)                                                       | `dme_organization.surety_bond_*` columns                                                                                                |
| (c)(28)                 | Accreditation in good standing                                           | `accreditation_surveys` rows                                                                                                            |

## OIG Compliance Program Guidance for DME Suppliers

| Requirement                                                | Where implemented                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OIG LEIE monthly screening (SAB 2013)                      | `resupply.oig_leie_exclusions` + `oig_leie_screenings` (mig 0141); monthly worker `oig-leie-sync` refreshes the cached list; per-subject screening at `/admin/compliance/oig-leie-screenings/run` |
| Designated compliance officer                              | `admin_users.role='compliance_officer'`; permission set in `lib/resupply-auth/src/rbac.ts`                                              |
| Written code of conduct + policies                         | `accreditation_policies` catalog (mig 0118)                                                                                            |
| Effective training + education                             | `staff_training_records`                                                                                                                |
| Effective lines of communication (grievances)              | `patient_grievances`                                                                                                                    |
| Internal monitoring + auditing                             | `audit_log` HMAC chain + `csr_compliance_alerts` daily sweep                                                                            |
| Well-publicized disciplinary guidelines                    | `accreditation_policies` slug `disciplinary_procedures`                                                                                 |
| Prompt response to detected offenses + corrective action   | `hipaa_breach_incidents` lifecycle + `quality_improvement_initiatives` PDSA loop                                                       |

## ACHC DMEPOS Accreditation Standards

| Standard                                                                   | Where implemented                                                                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| HR-1, HR-2 — Personnel files + training                                    | `staff_training_records` + `lib/compliance/training-expiry.ts`                                                   |
| QM-1 — QAPI program with ≥4 indicators, quarterly measurement              | `resupply.quality_improvement_initiatives` + `quality_improvement_measurements` (mig 0141); `/admin/compliance/qi-initiatives/*` |
| QM-2 — Annual QAPI evaluation                                              | `quality_improvement_initiatives.annual_evaluation_summary` + `annual_evaluation_completed_on`                   |
| LD-1 — Disaster preparedness                                               | `contingency_plan_attestations` + `disaster_preparedness_drills` (mig 0141)                                      |
| LD-3 — Patient grievance process                                           | `patient_grievances`                                                                                              |
| DRA-1, DRA-2 — Patient rights                                              | `patient_rights_requests` (mig 0141) + `patient_form_acknowledgements`                                          |
| ISA-1 — Annual self-assessment                                              | `accreditation_surveys` + readiness engine in `lib/accreditation/readiness-engine.ts`                            |

## Pennsylvania-specific

| Requirement                                                                 | Where implemented                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PA Medicaid HealthChoices MCO 7-day prior auth SLA                          | `pa-mco-sla-sweep` worker job; `prior_authorizations.expected_decision_at` enforces alert        |
| PA Breach of Personal Information Notification Act (73 P.S. §§ 2301–2309)   | `hipaa_breach_incidents.state_notice_required[]` + `state_notice_sent_at` (mig 0139)             |
| PA Department of Drug & Alcohol Programs disclosure rules                   | `patient_disclosure_log.disclosure_purpose='specialized_government'` for state-mandated reports  |

## Worker / job inventory (relevant to compliance)

| Job                                            | Cadence            | Compliance purpose                                                                                |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `compliance.oig_leie.sync`                     | Monthly (4th, 04:07 UTC) | Refreshes the cached OIG LEIE exclusion list — keeps screening current                            |
| `accreditation.readiness_sweep`                | Daily              | Builds per-domain readiness findings the next ACHC survey will inspect                            |
| `pa_mco_sla_sweep`                             | Hourly             | Surfaces PA Medicaid PA SLAs nearing the 7-day mark                                              |
| `prior_auth_expiry_sweep`                      | Daily              | Flags PAs nearing their expiration window                                                         |
| `dwo_expiry_sweep`                             | Weekly             | DWO/CMN/SWO T-60/T-30/T-7 alerts                                                                  |
| `patient_documents_retention_sweep`            | Daily              | HIPAA retention enforcement                                                                       |
| `audit_log_archive_sweep`                      | Nightly            | Audit log archiving + integrity verification                                                      |

## Permissions matrix (excerpt)

| Permission              | Roles                                                          | Used by routes                                                                                                  |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `compliance.read`       | super_admin, admin (super_admin, supervisor, compliance_officer) | All `GET /admin/compliance/*` routes                                                                            |
| `compliance.resolve`    | super_admin, admin                                             | All `POST/PATCH /admin/compliance/*` routes that create or update compliance artifacts                          |
| `training.manage`       | super_admin, admin                                             | `/admin/compliance/training-records/*`                                                                          |
| `grievances.resolve`    | super_admin, admin                                             | `/admin/compliance/grievances/*`                                                                                |

## Open follow-ups (not yet implemented)

- Periodic export of the §164.528 accounting to PDF for delivery to
  the patient (currently the patient-portal endpoint returns JSON only).
- Auto-mailing of the BAA renewal-reminder email 60 days before
  `agreement_expires_on` (admin UI surfaces it; the email itself is manual today).
- Auto-mailing of the OIG LEIE "overdue screening" reminder to the
  compliance officer (the coverage rollup surfaces it).
- Annual rotation of `RESUPPLY_AUDIT_HMAC_KEY` per §164.312(b) — currently manual.
