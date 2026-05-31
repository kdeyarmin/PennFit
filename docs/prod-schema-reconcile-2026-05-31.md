# Prod schema reconciliation — 2026-05-31

Follow-on to
[`incident-signin-500-schema-drift-2026-05-30.md`](./incident-signin-500-schema-drift-2026-05-30.md).
Records what was applied **out of band** to the PennPaps production project
(`uppdjphagdildcgkvdsz`) on 2026-05-31, and the larger drift discovered while
doing it.

## Method

The full `0000..0185` migration chain (205 files) was replayed into a scratch
Postgres 16 via the repo migrator (`lib/resupply-db/scripts/migrate.mjs`) to
produce a **canonical reference schema** (and a clean
`drizzle.resupply_migrations` ledger, 205 rows). Prod was then diffed against
that reference. All column types/defaults below were introspected from the
canonical replay (`format_type` + `pg_get_expr`) — not hand-authored — and
applied idempotently.

## Applied to prod (verified)

1. **65 additive columns** across 15 already-existing tables — the
   code-referenced subset that was causing latent 500s (the same class as the
   2026-05-30 sign-in outage): `payer_profiles` (25), `insurance_claims` (7),
   `fitter_leads` (9), `inbound_referral_orders` (5), `sleep_studies` (4),
   `prior_authorizations` (2), `office_ally_submissions` (2),
   `appointment_requests` (2), `ehr_fhir_tenants` (2), `inbound_webhooks` (2),
   `prescriptions.provider_id`, `era_files.payer_profile_id`,
   `eligibility_checks.applied_to_inbound_file_id`,
   `fitter_campaign_clicks.subject_variant_key`, `providers.portal_link_version`.
   Committed to the repo as migration
   **`0186_reconcile_prod_column_drift.sql`** (idempotent `ADD COLUMN IF NOT
   EXISTS`; no-op on a fresh replay). Verified: 65/65 present after apply.

2. **11 `resupply` RPC functions** (prod had only `set_updated_at`; canonical
   has 12) — `billing_denial_rate`, `record_fitter_touch_open`,
   `set_bulk_campaign_recipients_updated_at`, `shop_back_in_stock_queue`,
   `submit_inventory_reconciliation`, `therapy_fleet_overview`,
   `therapy_fleet_worklist`, `therapy_resupply_opportunities`,
   `therapy_resupply_summary`, `therapy_setup_adherence_list`,
   `therapy_setup_adherence_summary`. Applied verbatim `CREATE OR REPLACE` from
   the canonical replay (already defined by their original migrations in the
   repo; only prod was missing them). Verified: 12/12 present after apply.

Both applied via Supabase MCP `apply_migration`, so the
`drizzle.resupply_migrations` ledger on prod **still does not exist** (see
below).

## Larger drift discovered — NOT yet applied (needs a decision)

Prod is materially further behind than the code-referenced audit implied:

- **80 tables vs 136 canonical → 56 tables entirely absent on prod.**
- **1072 columns vs 1788 canonical → 716 missing**, of which **696 belong to
  the 56 absent tables**; the remaining ~20 are non-code-referenced columns on
  existing tables.

The 56 absent tables are real feature areas, several referenced by live code or
the worker (so latent 500s / inactive jobs), e.g. `webhook_subscriptions` +
`webhook_deliveries`, `bulk_campaigns` + `bulk_campaign_recipients`,
`claim_scrub_results` / `claim_denial_analyses` / `claim_appeal_letters`,
`inventory_reconciliations` + `inventory_reconciliation_lines` (the
`submit_inventory_reconciliation` RPC above references these), `alert_*`,
`recall_*`, `clearinghouse_credentials` + `clearinghouse_inbound_files`,
`hcpcs_codes` / `sku_hcpcs_map` / `product_hcpcs_map`, `csr_shifts`,
`dme_organization*`, `equipment_*`, `good_faith_estimates`,
`patient_coaching_plans`, `patient_worklist_actions`, `report_presets`,
`shop_backorders` / `shop_sku_substitutes`, `therapy_fleet_*`, etc. (full list:
`/tmp/missing_tables.txt` at audit time).

Provisioning 56 tables with their FKs, indexes, RLS policies, triggers, and seed
data on a live PHI database is the same class of change as the owner-approved
2026-05-30 Bucket-B effort (29 tables).

**Status: APPLIED + verified (2026-05-31, owner-approved "provision all 56").**
The byte-exact canonical DDL was applied to prod via Supabase MCP `apply_migration`
in ordered, individually-verified batches (pre-data → post-data → seeds). The
committed script
[`scripts/prod-reconcile/2026-05-31-provision-missing-56-tables.sql`](../scripts/prod-reconcile/2026-05-31-provision-missing-56-tables.sql)
(sha256 `07bc5792…ce1d`) is the source of truth.

Post-apply verification against the canonical full-chain replay:

| Check | Reference | Prod | |
| --- | --- | --- | --- |
| `resupply` base tables | 136 | 136 | ✓ |
| columns across the 56 tables | 696 | 696 | ✓ |
| PK / unique / FK / check constraints | 56 / 2 / 53 / 112 | 56 / 2 / 53 / 112 | ✓ |
| indexes / triggers | 147 / 1 | 147 / 1 | ✓ |
| core seed content (md5, ts-excluded) | — | — | ✓ `hcpcs_codes`, `sku_hcpcs_map`, `product_hcpcs_map`, `alert_definitions`, `claim_templates` all match |

prod's `ALTER DEFAULT PRIVILEGES` auto-granted `service_role` on every new table
(verified). A transcription drop of one `product_hcpcs_map` row was caught by the
row-count/checksum check and corrected.

**Two seed sets were deliberately NOT loaded via MCP** (load via the committed
`psql -f` script when a prod DB connection is available — see
[`scripts/prod-reconcile/README.md`](../scripts/prod-reconcile/README.md)):

- `alert_messages` (27 rows) — large HTML/SMS template bodies; hand-transcribing
  them via MCP is error-prone, and the alert system has code-level default
  rendering, so the table being empty is degraded-not-broken (the `alert_key →
  alert_definitions` FK is satisfied on the empty table).
- `payer_modifier_rules` (14 rows) — each references a `payer_profiles.id` **UUID
  from the reference replay** that does not exist in prod's (separately seeded)
  `payer_profiles`; the rows can't be transplanted and must be re-created against
  prod's actual payers (admin UI or a prod-relative seed).

## Recommended durable fix (incident follow-up #1, still open)

The root cause is the **missing migration ledger + no automated apply path**.
Replaying the chain into a scratch Postgres here produced a correct
`drizzle.resupply_migrations` ledger trivially — the same `migrate.mjs` run
against prod would both create the 56 tables/20 columns AND seed the ledger,
**if** prod's current ad-hoc state can be made to correspond to a clean apply
point. Because prod was assembled piecemeal (Bucket B verbatim tables, 0178,
incident DDLs, and now this reconcile), a from-scratch `migrate.mjs` would
collide on the objects that already exist. Options to discuss:

1. **Bring prod up via a careful, ordered table-provisioning pass** (Bucket-B
   style) for the 56 tables, then seed the ledger to `0185` and adopt
   `migrate.mjs` going forward.
2. **Rebuild onto a freshly-migrated database** and migrate data across (most
   correct, highest effort).

Either way, do NOT fabricate a `205-applied` ledger on the current prod without
first reconciling the 56 tables — that would make `migrate.mjs` skip the
migrations that create them. The shipped detector
(`pnpm --filter @workspace/scripts check:schema-drift` +
`.github/workflows/schema-drift.yml`) remains the interim guard.
