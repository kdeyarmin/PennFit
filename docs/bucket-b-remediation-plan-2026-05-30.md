# Bucket B remediation plan — restore the absent billing/integration tables

**Status: ✅ COMPLETED 2026-05-30** (owner-approved). All 29 Bucket B tables
were provisioned on production (`uppdjphagdildcgkvdsz`) from the verbatim
migration files, verified column-by-column against the live schema. See
**"Execution record"** at the bottom of this doc for exactly what was applied,
the mistake made on the first attempt, and how it was corrected. The planning
sections below are preserved as the historical rationale.

## What Bucket B is

The 2026-05-30 drift audit found **16+ entire tables** that the checked-in
migrations create but which did **not** exist on the production project
(`uppdjphagdildcgkvdsz`). Unlike Bucket A (additive columns on existing tables,
already fixed in migration `0178`), these are whole un-migrated feature areas —
primarily **insurance billing / claims / prior-auth** and **fitter lead
campaigns** — referenced by live code under
`artifacts/resupply-api/src/lib/billing/*`, `worker/jobs/office-ally-*`, and the
fitter routes. Those features were non-functional on this deployment until this
remediation.

## Why this is NOT a hand-written migration

Two findings make "write one ALTER script" the wrong approach:

1. **The 16 tables are created across ~14 historical migration files** (0071 →
   0154), several of which are _interleaved_ with already-applied work — e.g.
   `0134_billing_wave_2_next_items.sql` both creates Bucket B tables AND adds
   the `shop_customers.membership_*` columns that `0178` already applied. The
   files are individually idempotent (`CREATE TABLE IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`), so re-running them is safe; re-deriving their
   contents by hand is not.

2. **There are hidden prerequisites the column-level audit did not surface.**
   The Bucket B files carry 40+ foreign keys. A live check of their FK targets
   found that **`resupply.insurance_coverages` is also absent** and is a
   prerequisite for `prior_authorizations`, `insurance_claims`, and the billing
   wave — yet it was not in the original "16 tables" list (it has no
   `ADD COLUMN` of its own that the audit keys on). Any apply that doesn't go
   through the real migration files in order will hit an FK-target-missing
   error.

Conclusion: **execute the existing migration files via the repo migrator, in
numeric order, against the live DB** — do not improvise SQL.

## Prerequisites that already exist live (FK targets — verified 2026-05-30)

`patients`, `patient_documents`, `fulfillments` are present, so Bucket B FKs
into them resolve. Absent prerequisites that the run must create _before_ their
dependents: `insurance_coverages`, `providers`, `payer_profiles`,
`office_ally_submissions`, `insurance_claims`, `prior_authorizations`,
`inbound_webhooks`, `inbound_referral_orders`, `fitter_leads`.

## Dependency-ordered file list (numeric order already satisfies FKs)

The migrator applies by numeric prefix, and the historical numbering already
respects the FK graph below. Bucket-B-relevant files, in apply order, with
their cross-table FK references:

| File                                           | Creates (Bucket B)                                   | FK refs that must pre-exist                                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0071_providers`                               | `providers`                                          | (none)                                                                                                                                   |
| `0074_sleep_studies`                           | `sleep_studies`                                      | `patients`✓, `providers`(0071)                                                                                                           |
| `0076_prior_authorizations`                    | `prior_authorizations`                               | `insurance_coverages`(⚠ see below), `patients`✓                                                                                          |
| `0104_appointment_requests`                    | `appointment_requests`                               | (none)                                                                                                                                   |
| `0114_fitter_leads`                            | `fitter_leads`                                       | (none)                                                                                                                                   |
| `0118_insurance_claims`                        | `insurance_claims` (+2)                              | `fulfillments`✓, `insurance_coverages`(⚠), `patient_documents`✓, `patients`✓                                                             |
| `0128_pa_payer_profiles`                       | `payer_profiles`, `office_ally_submissions`          | self                                                                                                                                     |
| `0129_billing_enhancements`                    | `era_files` (+2)                                     | `insurance_coverages`(⚠), `office_ally_submissions`(0128), `payer_profiles`(0128), `providers`(0071)                                     |
| `0134_billing_wave_2_next_items`               | `davinci_pas_submissions`, `eligibility_checks` (+5) | `insurance_claims`(0118), `insurance_coverages`(⚠), `patients`✓, `payer_profiles`(0128), `prior_authorizations`(0076), `providers`(0071) |
| `0138_phase_6_payments_and_inbound`            | `inbound_webhooks` (+2)                              | `patients`✓                                                                                                                              |
| `0144_inbound_referral_orders`                 | `inbound_referral_orders` (+1)                       | `inbound_webhooks`(0138), `patients`✓, `providers`(0071)                                                                                 |
| `0147_ehr_fhir_tenants`                        | `ehr_fhir_tenants`                                   | (none)                                                                                                                                   |
| `0151_fitter_completion_and_supply_campaign`   | `fitter_campaign_touches`                            | `fitter_leads`(0114)                                                                                                                     |
| `0154_fitter_campaign_clicks_and_csr_workflow` | `fitter_campaign_clicks`                             | `fitter_leads`(0114)                                                                                                                     |

⚠ **`insurance_coverages`** — absent live and referenced by 0076/0118/0129/0134.
Created by **`0075_insurance_coverages.sql`** (numerically before its first
consumer 0076), so a full ordered migrator run handles it automatically. It is
called out here only because a _piecemeal_ apply of the table list above would
omit it and fail on the first FK into it.

## Recommended execution (in the maintenance window)

The robust path is to **run the repo migrator** (`lib/resupply-db/scripts/migrate.mjs`)
against the live DB so every pending file applies in order and is recorded in
the `drizzle.resupply_migrations` ledger — which also closes the "no ledger"
gap permanently. BUT note the CI comment in `.github/workflows/ci.yml`
(test job) that a **from-scratch** replay is currently broken (~17
ordering/role failures, e.g. 0060 referencing `reminder_subscriptions` created
unqualified in 0027). Production is NOT from-scratch — it already has the early
schema — so the relevant question is whether the migrator, pointed at prod with
a freshly-seeded ledger reflecting _what is actually already applied_, cleanly
applies only the pending Bucket A/B files.

Sequence:

1. **Seed the ledger to match reality first** (see the ledger-bootstrap note in
   the incident doc / the ledger plan). Without this, the migrator treats
   every one of the ~190 files as pending and will replay early historical
   migrations that assume a clean DB — exactly the broken-from-scratch path.
   The ledger must be seeded so only the genuinely-pending files (Bucket A,
   already applied as 0178 + 0142 + 0143; and Bucket B) remain.
2. **Dry-run / inventory** against a staging copy or a Supabase branch
   (`mcp supabase create_branch`) restored from prod, and run the migrator
   there end to end. Fix any ordering/`insurance_coverages` issues on the
   branch.
3. **Apply in a maintenance window** with a fresh backup/PITR checkpoint taken
   immediately before.
4. **Verify** with `pnpm --filter @workspace/scripts check:schema-drift`
   (added in this work) pointed at prod — expect zero missing tables/columns
   afterwards (modulo the intentional `audit_log` allowlist).
5. **Smoke-test** the billing/integration workers boot cleanly
   (`office-ally-inbound-poll`, claim builder, fitter campaign jobs).

## Open decision for the owner

Is the insurance-billing / claims / prior-auth / fitter-campaign suite **meant
to be live** on this instance? If those features are intentionally dormant
(e.g. this deployment is storefront + resupply only), the correct action may be
to **exclude** their migrations rather than apply them — in which case the
drift checker's `INTENTIONAL_ABSENCES` allowlist should be extended to cover
them so the daily signal stays green and honest.

**Owner decision (2026-05-30): PROVISION.** The owner directed that the suite be
made live, so the tables were created — see the execution record below.

---

## Execution record (2026-05-30) — COMPLETED

**29 tables provisioned on `uppdjphagdildcgkvdsz`** from the source migrations
0071, 0074, 0075, 0076, 0104, 0114, 0118, 0128, 0129, 0134, 0138 (the
`inbound_webhooks` + `documentation_packets` portions only — `patient_payments`
already existed correctly), 0144, 0147, 0151, 0153 (fitter
engagement columns, a prerequisite that surfaced during apply), and 0154.

Tables created: `providers`, `sleep_studies`, `insurance_coverages`,
`prior_authorizations`, `appointment_requests`, `fitter_leads`,
`insurance_claims`, `insurance_claim_line_items`, `insurance_claim_events`,
`payer_profiles`, `office_ally_submissions`, `denial_codes`,
`payer_fee_schedules`, `era_files`, `eligibility_checks`,
`medicare_same_or_similar_checks`, `capped_rental_cycles`, `dwo_documents`,
`adherence_predictions`, `voice_reorder_sessions`, `davinci_pas_submissions`,
`inbound_webhooks`, `documentation_packets`, `inbound_referral_orders`,
`inbound_referral_documents`, `ehr_fhir_tenants`, `fitter_campaign_touches`,
`fitter_campaign_clicks`. Plus the `insurance_claims` /
`shop_customers` / `fitter_leads` ALTER columns those migrations add, and the
seed data (26 PA payer profiles, 49 CARC/RARC denial codes, the
`fitter_supply_campaign.dispatcher` feature flag).

RLS was then enabled on every new table (same catalog-loop block as migration
0170), matching the service-role-only posture of the rest of the schema.

### Verification (post-apply, against live prod)

- 29/29 tables present; 29/29 RLS-enabled; 29/29 service-role-writable;
  0/29 readable by `anon` (deny-all default — correct).
- Column fidelity confirmed against the source files: `insurance_claims` carries
  all 8 real columns (`insurance_coverage_id`, `payer_name`, `date_of_service`,
  `total_billed_cents`, `patient_responsibility_cents`, `payer_profile_id`,
  `rendering_provider_id`, `secondary_coverage_id`); `prior_authorizations` 5/5;
  `payer_profiles` 5/5; `fitter_leads.id` is `text` (not `uuid`).
- Security advisor: only `INFO` `rls_enabled_no_policy` on the new tables — the
  documented, intended end-state for service-role-only tables (no ERROR/WARN).

### Correction notice — first attempt was wrong, then fixed

The **first** apply pass used **DDL reconstructed from memory** rather than the
verbatim migration files. That produced ~28 tables with the wrong columns (e.g.
a fabricated `insurance_claims` with `coverage_id` / `total_charge_cents`
instead of the real `insurance_coverage_id` / `total_billed_cents`), dropped the
seed data, and used `uuid` where `fitter_leads.id` is `text`. The error was
caught by a column-fidelity check during verification. Because the tables were
brand-new and **empty (0 rows)**, recovery was lossless: the 28 fabricated
tables were dropped (CASCADE; `patient_payments` deliberately untouched — it
pre-existed with the correct schema) and recreated from the **verbatim** file
SQL, after which all the checks above passed. Lesson for next time: apply
migration files **verbatim**, and verify **columns/seeds**, not just table
presence + RLS.

### How this was applied vs. the recommended path

This was applied **table-by-table via Supabase `apply_migration`** (the MCP
path), NOT via `lib/resupply-db/scripts/migrate.mjs`. So the
`drizzle.resupply_migrations` ledger still does not reflect these — the "no
ledger" gap (follow-up #1 in the incident doc) remains open and is the right
next investment. A Supabase branch dry-run (`bucket-b-dryrun`) was created to
validate first, then deleted.

### Operational consequence — workers now self-activate

The worker's `registerIfProvisioned` guard skips jobs whose tables are absent.
Now that these tables exist, on the **next worker boot** the previously-skipped
jobs (`office-ally-inbound-poll`, `prior-auth.expiry-sweep`, `dwo.expiry-sweep`,
the inbound-referral cluster, fitter campaign dispatchers, etc.) will
self-register and begin running. Several need env configuration to do useful
work (`OFFICE_ALLY_*`, `RESUPPLY_INBOUND_REFERRALS_ENABLED`, etc.) and will
otherwise no-op or log; review env + feature-flag posture before/after the next
deploy.
