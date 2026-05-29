# Production DB schema drift — inventory & triage (2026-05-29)

## TL;DR

The production Supabase project (**PennPaps**, `uppdjphagdildcgkvdsz`) was
provisioned with only a **core subset** of the application schema. It has
**44** `resupply.*` tables; the repo's migrations describe **~128**. So
**~84 expected tables are missing.**

- The missing tables are **genuinely expected** — verified that the
  compliance tables retired by migration `0156` (`accreditation_*`,
  `hipaa_*`, `oig_*`, `patient_disclosure_log`, `business_associate_agreements`,
  etc.) are correctly **excluded** from this list. None of the 84 are
  "retired-on-purpose."
- Every table prod *does* have is an expected one — no rogue or renamed
  tables. It's a clean subset, just incomplete.
- This DB was built by **8 Supabase-native migrations**, not the repo's
  migration runner (`drizzle.resupply_migrations` history is absent).

**Why it matters:** core storefront + the chatbot work (their tables are in
the 44). But several missing tables are read/written by **active, scheduled
code** — not just dormant features — so there is real, partly-silent
breakage. Triage below.

## How this was measured (and its limits)

Approximate diff via grep over `lib/resupply-db/drizzle/*.sql`:
`expected = (distinct CREATE TABLE resupply.*) − (DROP TABLE resupply.*)`,
then `missing = expected − (live tables)`. This is good enough to scope and
triage, but it does **not** account for per-table column/constraint
evolution across later `ALTER` migrations.

**The correct way to produce exact remediation DDL** (do this before
applying anything to prod): run the full migration set against a throwaway
Postgres (`lib/resupply-db/scripts/migrate.mjs` against an empty DB),
`pg_dump --schema-only`, and diff that canonical schema against production.
Apply the missing objects **in dependency order** (tables many others FK to
first). Do not hand-assemble DDL from grep — later migrations add columns,
indexes, and FKs that a bare `CREATE TABLE` would miss.

## Triage

### Tier 0 — ✅ DONE (created 2026-05-29; touched by active/scheduled code)

These are referenced by code that runs today, so their absence likely causes
real (often silent) failures, not just dormant-feature no-ops.

| Table | Used by | Impact if missing |
| ----- | ------- | ----------------- |
| `worker_dedup_keys` | `worker/jobs/reminders.ts` | Reminder **idempotency** — dispatcher may error or risk duplicate/again-skipped sends. Reminders are a core feature. |
| `stripe_webhook_events` | `lib/stripe/webhook-handler.ts` | Stripe webhook **dedup/idempotency** — payment/subscription events may double-process or error. |
| `patient_payments` | `routes/storefront/me-payments.ts`, `lib/billing/patient-payment.ts` | Recording patient card payments fails. |
| `patient_billing_statements` | `routes/storefront/me-billing.ts` | Patient statement history/PDF re-render fails. |
| `admin_mfa_secrets`, `admin_mfa_recovery_codes` | `lib/auth-deps.ts`, `routes/admin/mfa.ts` | Admin MFA enrollment/verification fails. Verify whether MFA is enforced on sign-in. |
| `feature_flag_events` | `routes/admin/feature-flags.ts` | Admin Control Center toggle-audit writes fail (the flag still flips, but the activity log errors). |

**Status — created 2026-05-29.** All 7 tables backfilled (DDL taken faithfully
from repo migrations `0160`/`0158`/`0163`/`0084`+`0091`/`0085`/`0137`/`0138`,
cross-checked against `supabase-types.ts` column-by-column), `service_role`
grants confirmed, and the PostgREST schema cache reloaded
(`NOTIFY pgrst, 'reload schema'`) so the app's service-role data path sees
them. The reminders dedup, Stripe webhook dedup, patient payments/statements,
admin MFA, and feature-flag toggle-audit paths no longer hit missing tables.

> ⚠️ **Type drift discovered while doing this** — important for Tiers 1–3:
> production's `resupply.admin_users.id` is **`text`**, but the repo's
> migrations declare it `uuid`. The two `admin_mfa_*` tables were therefore
> created with `staff_user_id` **`text`** (not `uuid`) to satisfy the FK.
> **Lesson:** existing prod tables differ from the repo not just in *presence*
> but in column *types*. Any FK in a backfilled table must be matched to
> production's **actual** target-column type — confirm via
> `information_schema.columns`, don't assume the repo DDL. (`patients.id`
> *is* `uuid`, so the `patient_*` FKs matched as-is.) This also means a naive
> "apply the repo migrations" reconciliation would fail; the clean-DB-diff
> approach must account for these pre-existing type differences.

### Tier 1 — Insurance billing / claims (RCM)

Core to a DME business **if you bill insurance**. Currently dormant.

`insurance_claims`, `insurance_claim_events`, `insurance_claim_line_items`,
`insurance_coverages`, `eligibility_checks`, `prior_authorizations`,
`davinci_pas_submissions`, `claim_appeal_letters`, `claim_denial_analyses`,
`claim_scrub_results`, `claim_templates`, `denial_codes`, `era_files`,
`clearinghouse_credentials`, `clearinghouse_inbound_files`,
`office_ally_submissions`, `payer_fee_schedules`, `payer_modifier_rules`,
`payer_profiles`, `good_faith_estimates`, `medicare_same_or_similar_checks`,
`capped_rental_cycles`, `dwo_documents`, `documentation_packets`,
`prescription_request_packets`, `dispense_readiness_reviews`,
`product_hcpcs_map`

Has a scheduled job: `worker/jobs/office-ally-inbound-poll.ts` (ERA/claims
polling) — will fail until these exist.

**Recommendation:** enable as one unit only if/when you turn on automated
insurance billing. Otherwise defer and disable the office-ally poll job.

### Tier 2 — EHR / inbound referrals / providers

The **failing worker jobs you observed** (`inbound_referral.*`,
`inbound_webhook_dispatch`) live here.

`ehr_fhir_tenants`, `inbound_referral_orders`, `inbound_referral_documents`,
`inbound_referral_preflight_checks`, `inbound_referral_status_outbox`,
`inbound_webhooks`, `inbound_faxes`, `webhook_deliveries`,
`webhook_subscriptions`, `providers`, `providers_pecos_status`,
`patient_referrals`, `appointment_requests`, `clinician_share_tokens`

Scheduled jobs that fail today: `inbound-referral-preflight.ts`,
`inbound-referral-status-outbound.ts`, `inbound-webhook-dispatch.ts`.

**Recommendation:** if you don't ingest EHR/FHIR referrals, **disable these
dispatchers** (stops the log noise) rather than create the tables. If you do,
create the set together.

### Tier 3 — Growth / ops / clinical (dormant, lower urgency)

- **Campaigns/leads:** `bulk_campaigns`, `bulk_campaign_recipients`,
  `fitter_campaign_clicks`, `fitter_campaign_touches`, `fitter_leads`
- **Equipment / recalls / inventory:** `equipment_assets`,
  `equipment_recalls`, `recall_notifications`, `recall_remediation_actions`,
  `inventory_reconciliations`, `inventory_reconciliation_lines`,
  `low_stock_alert_state`, `shop_backorders`, `shop_sku_substitutes`
- **Clinical / coaching:** `patient_coaching_plans`,
  `patient_therapy_milestones`, `patient_maintenance_log`,
  `patient_maintenance_nudges`, `adherence_predictions`, `sleep_studies`,
  `conversation_coaching_notes`, `patient_address_history`,
  `patient_fit_overrides`, `patient_form_acknowledgements`,
  `patient_identity_verifications`, `patient_grievances`
- **Ops / misc:** `report_presets`, `voice_reorder_sessions`, `csr_shifts`,
  `office_closures`, `office_recurring_closures`, `shop_order_loss_claims`,
  `shop_order_nps_responses`, `dme_organization`, `dme_organization_contacts`,
  `worker_run_summary`

**Recommendation:** create per-feature as you decide to use each. Several
have dispatchers gated by feature flags (`bulk_campaigns.send`,
`cart_abandonment.dispatcher`, `smart_triggers.dispatcher`,
`patient_onboarding.dispatcher`) — those flags exist now (seeded with
`0149`), but the underlying tables for some still need creating before the
feature truly works.

## Suggested path

1. **Now (low risk):** create the **Tier 0** tables (small, in active use),
   using DDL extracted via the clean-DB-dump method above. Biggest
   correctness win for the least surface area.
2. **Decide per feature area** (Tiers 1–3) based on what the business
   actually uses. For areas you won't use yet, **disable their scheduled
   dispatchers** so the worker stops erroring (cheaper than creating tables
   you won't use).
3. **Long term:** adopt one source of truth for the prod schema — either run
   the repo's migration runner against this DB going forward (after a
   one-time backfill so `drizzle.resupply_migrations` reflects reality), or
   formally treat the Supabase-native migrations as canonical and stop
   maintaining the divergent repo set. Today they disagree, which is how this
   drift went unnoticed. See
   [`docs/migration-state-investigation-2026-05-08.md`](./migration-state-investigation-2026-05-08.md).

## Already fixed (2026-05-29)

- `resupply.feature_flags` created (unblocked `/readyz` → restored the API
  deploy; see
  [`docs/runbooks/chatbot-down-api-not-served-2026-05-29.md`](./runbooks/chatbot-down-api-not-served-2026-05-29.md)).
- Chatbot + core storefront confirmed working on `pennfit.up.railway.app`.
- **Tier 0 tables backfilled** (7 tables — see that section above): the
  active-code drift (reminders dedup, Stripe dedup, patient payments,
  admin MFA, feature-flag audit) is resolved. Tiers 1–3 remain a per-feature
  decision.
