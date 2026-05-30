# Incident: admin/customer sign-in 500s — `resupply_auth` schema drift (2026-05-30)

## Summary

Every real sign-in on `pennpaps.com` (and `pennfit.up.railway.app`) failed with
the SPA banner **"We can't reach the credentials store right now…"**. The
banner is the storefront's rendering of any `status >= 500` from
`POST /api/auth/sign-in` (see `lib/resupply-auth-react/src/error-message.ts`).

Root cause: the production Supabase database (project `uppdjphagdildcgkvdsz`,
"PennPaps") was missing the column **`resupply_auth.password_credentials.set_by_admin_at`**
(added by migration `0142`). The sign-in handler selects and reads that column
for **every existing user** (`findCredentialByUserId` →
`supabase-repository.ts` `CRED_COLS`; consumed at
`lib/resupply-auth/src/http/sign-in.ts` ~line 240, `cred.setByAdminAt`). With
the column absent, PostgREST returned an error, the repository threw, Express
returned 500, and the SPA showed the "credentials store" banner.

Why it was easy to misread from the outside:

- A **non-existent** email returned a clean `401 invalid_credentials` — that
  path exits at the "no such user" branch **before** the credential SELECT.
- A **real** email reached the credential SELECT and 500'd.
- `/resupply-api/healthz`, `/resupply-api/readyz` (`db:ok`), and
  `/api/auth/csrf` were all `200` — none of them touches that column, so the
  infra all looked healthy.

## Resolution (applied to production 2026-05-30)

Two additive, idempotent migrations were applied directly to project
`uppdjphagdildcgkvdsz` to restore login and unblock the invite-expiry sweep:

```sql
-- 0142
ALTER TABLE "resupply_auth"."password_credentials"
  ADD COLUMN IF NOT EXISTS "set_by_admin_at" timestamp with time zone;

-- 0143
ALTER TABLE "resupply_auth"."password_credentials"
  ADD COLUMN IF NOT EXISTS "expiry_reminder_sent_at" timestamp with time zone;
ALTER TABLE "resupply_auth"."password_credentials"
  ADD COLUMN IF NOT EXISTS "expired_notice_sent_at" timestamp with time zone;
```

Verification: `POST /api/auth/sign-in` with a real admin email + a deliberately
wrong password now returns `401 invalid_credentials` (it reaches password
verification) instead of `500`. The `resupply_auth.password_credentials`
columns were confirmed present after the change.

These two DDLs were applied **out of band** (incident recovery) and are
therefore not otherwise represented as applied state in the repo — this doc is
the record. The migration `.sql` files (`0142`, `0143`) already exist in
`lib/resupply-db/drizzle/` and were applied verbatim.

## Broader finding: the production DB is materially behind the migrations

There is **no `drizzle.resupply_migrations` ledger** on this project, so applied
state cannot be read back; migrations were evidently applied partially/ad hoc.
A heuristic audit (parse all 190 `lib/resupply-db/drizzle/*.sql` for
`ADD COLUMN`/`CREATE TABLE`/`DROP`/`RENAME` targeting `resupply` /
`resupply_auth`, then ask the live DB which expected objects are absent) found
**129 expected columns absent**, which split into two very different buckets:

### Bucket A — table exists, columns missing (real additive drift) — RESOLVED

~38 columns across 10 existing tables. These are the dangerous ones: the table
is live and in use, but code that reads/writes the newer columns will 500 the
same way sign-in did. Tables: `admin_users`, `audit_log`\*, `conversations`,
`fulfillments`, `patient_documents`, `patients`, `prescriptions`,
`shop_customers`, `shop_orders`, `shop_returns`.

Confirmed-live example: `shop_orders.pod_object_key / pod_uploaded_at /
pod_signed_name` are referenced by 5 live route files
(`routes/admin/shop-order-pod*.ts`, `routes/shop/order-pod.ts`, etc.) — POD
upload/proof-of-delivery was broken until these were added.

**Resolution (2026-05-30):** the safe subset — 33 columns whose target table
already exists AND which current code references — was consolidated into
migration **`0178_reconcile_bucketA_column_drift.sql`** (faithful types/defaults,
idempotent `ADD COLUMN IF NOT EXISTS`) and applied to `uppdjphagdildcgkvdsz`.
Re-running the drift check afterward: 33/33 present, 0 missing.

Two Bucket-A-shaped columns were **deliberately excluded** from 0178:

\* **`audit_log.signature / chain_seq / prev_signature / archived_at`** —
flagged by the heuristic but **intentionally absent**: migration 0156 retired
audit-log tamper-evidence (see `CLAUDE.md` "No HIPAA/DMEPOS/ACHC compliance
machinery") and current code has **0** references to them. Re-adding would
resurrect dead schema.

\* **`prescriptions.provider_id`** — it is a foreign key to `resupply.providers`,
which is a Bucket B (entirely-absent) table. It cannot be added until
`providers` exists, so it travels with the Bucket B remediation, not here.

### Bucket B — entire table absent (un-migrated feature areas)

16 migration-created tables do not exist at all on production, e.g.
`insurance_claims`, `payer_profiles`, `office_ally_submissions`, `era_files`,
`prior_authorizations`, `davinci_pas_submissions`, `ehr_fhir_tenants`,
`eligibility_checks`, `inbound_referral_orders`, `inbound_webhooks`,
`fitter_leads`, `fitter_campaign_touches`, `fitter_campaign_clicks`,
`appointment_requests`, `providers`, `sleep_studies`.

Much of this is referenced by live billing/integration code
(`artifacts/resupply-api/src/lib/billing/*`, `worker/jobs/office-ally-*`), so
those features are non-functional on this deployment. This is a whole-feature
migration gap, not a column patch, and needs a deliberate
apply-in-dependency-order pass (and likely a decision about whether these
features are meant to be live on this instance at all).

## Recommended follow-ups (NOT yet done)

1. **Restore a migration ledger / runner.** Decide how migrations are applied
   to this project going forward (`lib/resupply-db/scripts/migrate.mjs` against
   `DATABASE_URL`, or a tracked apply log). Without it, drift recurs silently
   and the next missing column is the next outage. **Interim detector shipped:**
   `scripts/src/check-schema-drift.ts` (`pnpm --filter @workspace/scripts
check:schema-drift`) compares the migration DDL against any live DB and exits
   non-zero on drift; it also reports whether the `drizzle.resupply_migrations`
   ledger exists. Wired into `.github/workflows/schema-drift.yml` (daily cron +
   manual dispatch), gated on a read-only `SCHEMA_DRIFT_DATABASE_URL` secret.
2. **Bucket A:** ✅ done — applied via `0178_reconcile_bucketA_column_drift.sql`
   (33 columns; retired `audit_log` columns and the `providers`-dependent
   `prescriptions.provider_id` deliberately excluded).
3. **Bucket B:** apply the table-creating migrations in dependency order in a
   maintenance window; verify the billing/integration workers boot cleanly
   afterward. **Detailed plan written:**
   [`bucket-b-remediation-plan-2026-05-30.md`](./bucket-b-remediation-plan-2026-05-30.md)
   — 16+ absent tables across ~14 migration files (0071–0154), FK-ordered, with
   the hidden `insurance_coverages` (0075) prerequisite called out and an open
   product decision about whether these features should be live at all. **No
   Bucket B DDL applied** — gated on owner sign-off + maintenance window.
4. **CI drift check — shipped** (see item 1): `.github/workflows/schema-drift.yml`.

## Repro / audit tooling

The audit was a throwaway parser (`/tmp/drift_audit.py`) that emits a
`WITH expected(s,t,c) AS (VALUES …)` query and lets the database compute the
missing set. It is heuristic (textual DDL parsing; does not read columns inside
`CREATE TABLE` bodies; needs per-column code confirmation). If we want this as a
durable check it should be rewritten against the real applied-migration history
once a ledger exists.
