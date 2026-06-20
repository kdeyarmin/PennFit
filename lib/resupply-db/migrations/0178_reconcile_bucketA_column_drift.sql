-- 0178_reconcile_bucketA_column_drift — backfill columns that earlier
-- migrations added but which were never applied to the PennPaps
-- production project (uppdjphagdildcgkvdsz).
--
-- Context. On 2026-05-30 sign-in was 500ing because
-- resupply_auth.password_credentials.set_by_admin_at (migration 0142) was
-- missing on prod. Investigating that revealed the project has no
-- drizzle.resupply_migrations ledger and is materially behind the migration
-- set — see docs/incident-signin-500-schema-drift-2026-05-30.md.
--
-- This migration consolidates the **safe, additive** subset of that drift:
-- columns whose target TABLE already exists on prod AND which current
-- application code reads/writes. Every statement is idempotent
-- (ADD COLUMN IF NOT EXISTS) and faithful to the original migration's type
-- and default, so re-running or running on an already-current database is a
-- no-op.
--
-- DELIBERATELY EXCLUDED (do not add here):
--   * resupply.audit_log.{signature,chain_seq,prev_signature,archived_at} —
--     these audit-log tamper-evidence columns are absent on prod because the
--     migrations that introduced them were never applied; the tamper-evidence
--     feature was since retired (compliance machinery removed) and current
--     code has zero references, so they are intentionally NOT restored here.
--   * resupply.prescriptions.provider_id — FK to resupply.providers, which
--     does NOT exist on prod (Bucket B). Must be applied together with the
--     providers table in the separate Bucket-B remediation, or it errors.
--   * All 16 entirely-absent "Bucket B" tables (insurance_claims,
--     payer_profiles, office_ally_submissions, era_files,
--     prior_authorizations, providers, sleep_studies, fitter_*, etc.) —
--     those are a feature-area migration, handled separately under change
--     control, not folded into this additive reconcile.

-- admin_users.skills (0xxx_admin_skill_routing) ----------------------------
ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "skills" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- conversations skill-routing / triage (skill routing + snooze) ------------
ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "required_skills" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "resupply"."conversations"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;

-- fulfillments backorder substitution --------------------------------------
ALTER TABLE "resupply"."fulfillments"
  ADD COLUMN IF NOT EXISTS "substituted_from_sku" text;

-- patient_documents retention / destruction (0089) -------------------------
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "retention_until_at" timestamp with time zone;
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "legal_hold" boolean NOT NULL DEFAULT false;
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "retention_marked_at" timestamp with time zone;
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "destroyed_at" timestamp with time zone;
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "destroyed_by_admin_id" text
    REFERENCES "resupply"."admin_users"("id") ON DELETE SET NULL;

-- companion partial index for the nightly retention sweep (from 0089)
CREATE INDEX IF NOT EXISTS "patient_documents_retention_sweep_idx"
  ON "resupply"."patient_documents" ("retention_until_at")
  WHERE retention_marked_at IS NULL
    AND destroyed_at IS NULL
    AND legal_hold = false;

-- patients lifecycle email / timezone --------------------------------------
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'America/New_York';
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "quarterly_summary_last_sent_at" timestamp with time zone;
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "birthday_email_year_sent" integer;
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "sleep_anniversary_year_sent" integer;

-- prescriptions HCPCS (provider_id intentionally excluded — see header) ----
ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "hcpcs_code" varchar(12);

-- shop_customers caregiver access + membership + winback/deductible --------
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_email" text;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_name" text;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_consent_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "caregiver_revoked_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "winback_sent_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "deductible_reset_year" integer;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "membership_tier" text;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "membership_started_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "membership_renews_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_customers"
  ADD COLUMN IF NOT EXISTS "membership_stripe_subscription_id" varchar(80);

-- companion partial indexes for shop_customers worker hot paths
-- (caregiver from 0123, winback from 0122, membership from 0134 wave 2)
CREATE INDEX IF NOT EXISTS "shop_customers_caregiver_active_idx"
  ON "resupply"."shop_customers" ("customer_id")
  WHERE "caregiver_consent_at" IS NOT NULL
    AND "caregiver_revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "shop_customers_winback_eligible_idx"
  ON "resupply"."shop_customers" ("winback_sent_at" NULLS FIRST);
CREATE INDEX IF NOT EXISTS "shop_customers_membership_active_idx"
  ON "resupply"."shop_customers" ("membership_tier", "membership_renews_at")
  WHERE "membership_tier" IS NOT NULL
    AND "membership_tier" <> 'payg';

-- shop_orders proof-of-delivery + refunds + delivery follow-up -------------
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_object_key" text;
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_uploaded_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "pod_signed_name" varchar(160);
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "amount_refunded_cents" bigint NOT NULL DEFAULT 0;
ALTER TABLE "resupply"."shop_orders"
  ADD COLUMN IF NOT EXISTS "delivery_followup_sent_at" timestamp with time zone;

-- companion partial index for the delivery-followup dispatcher (from 0119).
-- delivered_at predates this reconcile (base shop_orders table), so the
-- predicate column already exists on every target DB.
CREATE INDEX IF NOT EXISTS "shop_orders_delivery_followup_due_idx"
  ON "resupply"."shop_orders" ("delivered_at" DESC)
  WHERE "delivered_at" IS NOT NULL
    AND "delivery_followup_sent_at" IS NULL;

-- shop_returns refund retry bookkeeping ------------------------------------
ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_failure_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_last_failure_at" timestamp with time zone;
ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "refund_last_failure_reason" text;
