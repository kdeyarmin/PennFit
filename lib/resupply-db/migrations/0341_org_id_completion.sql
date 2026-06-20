-- 0338_org_id_completion — multi-tenant org_id backfill, COMPLETION batch.
-- Phase 0, plan workstream A2.
--
-- Adds org_id to every remaining TENANT-SCOPED table in the resupply
-- schema that the earlier batches (0331-0337) missed, per the full
-- schema inventory. After this, every tenant-scoped table carries
-- org_id and the route cutover is no longer gated on missing columns.
--
-- DELIBERATELY EXCLUDED (not backfilled here):
--   * Retired-compliance-domain tables (migration 0156: patient_grievances,
--     staff_training_records, hipaa_*, oig_leie_screenings, etc.) — the
--     "no compliance machinery" hard rule; inert, not live tenant data.
--   * Tables already keyed by organization_id (accreditation_*,
--     dme_organization_contacts, dme_ownership_disclosures) — Phase-1
--     reconciliation, not a redundant second key.
--   * Global/reference catalogs (hcpcs_codes, denial_codes, providers,
--     education_videos, sku_hcpcs_map, product_costs, ...) and system
--     tables (idempotency_keys, stripe_webhook_events, worker_*,
--     object_storage_acls, *_events audit) — correctly stay unscoped.
--   * admin_mfa_* / admin_policy_attestations — pending the
--     "are admins single-org?" decision (admin_users already has org_id).
--
-- NOTE: video_visits is a real table (created in 0307) but is MISSING
-- from lib/resupply-db/src/supabase-types.ts (a pre-existing stale-types
-- gap). Its org_id column is added here; the TS type + its route cutover
-- are deferred until the generated types are refreshed.
--
-- Identical safe additive shape to 0332/0337: NULLABLE org_id + backfill
-- to the seed tenant (slug 'penn-home-medical') + FK + per-table index.
-- No existing INSERT breaks (nullable), nothing reads/filters org_id yet
-- (no behavior change). NOT NULL + cutover land per-domain later.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── call_dispositions ──
ALTER TABLE "resupply"."call_dispositions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."call_dispositions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "call_dispositions_org_idx"
  ON "resupply"."call_dispositions" ("org_id");
--> statement-breakpoint
-- ── alert_message_overrides ──
ALTER TABLE "resupply"."alert_message_overrides"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."alert_message_overrides"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_message_overrides_org_idx"
  ON "resupply"."alert_message_overrides" ("org_id");
--> statement-breakpoint
-- ── patient_integration_snapshots ──
ALTER TABLE "resupply"."patient_integration_snapshots"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_integration_snapshots"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_integration_snapshots_org_idx"
  ON "resupply"."patient_integration_snapshots" ("org_id");
--> statement-breakpoint
-- ── physician_fax_outreach ──
ALTER TABLE "resupply"."physician_fax_outreach"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."physician_fax_outreach"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "physician_fax_outreach_org_idx"
  ON "resupply"."physician_fax_outreach" ("org_id");
--> statement-breakpoint
-- ── sleep_studies ──
ALTER TABLE "resupply"."sleep_studies"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."sleep_studies"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sleep_studies_org_idx"
  ON "resupply"."sleep_studies" ("org_id");
--> statement-breakpoint
-- ── insurance_coverages ──
ALTER TABLE "resupply"."insurance_coverages"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."insurance_coverages"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_coverages_org_idx"
  ON "resupply"."insurance_coverages" ("org_id");
--> statement-breakpoint
-- ── medicare_same_or_similar_checks ──
ALTER TABLE "resupply"."medicare_same_or_similar_checks"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."medicare_same_or_similar_checks"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medicare_same_or_similar_checks_org_idx"
  ON "resupply"."medicare_same_or_similar_checks" ("org_id");
--> statement-breakpoint
-- ── capped_rental_cycles ──
ALTER TABLE "resupply"."capped_rental_cycles"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."capped_rental_cycles"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "capped_rental_cycles_org_idx"
  ON "resupply"."capped_rental_cycles" ("org_id");
--> statement-breakpoint
-- ── dwo_documents ──
ALTER TABLE "resupply"."dwo_documents"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."dwo_documents"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dwo_documents_org_idx"
  ON "resupply"."dwo_documents" ("org_id");
--> statement-breakpoint
-- ── adherence_predictions ──
ALTER TABLE "resupply"."adherence_predictions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."adherence_predictions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "adherence_predictions_org_idx"
  ON "resupply"."adherence_predictions" ("org_id");
--> statement-breakpoint
-- ── patient_billing_statements ──
ALTER TABLE "resupply"."patient_billing_statements"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_billing_statements"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_billing_statements_org_idx"
  ON "resupply"."patient_billing_statements" ("org_id");
--> statement-breakpoint
-- ── dispense_readiness_reviews ──
ALTER TABLE "resupply"."dispense_readiness_reviews"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."dispense_readiness_reviews"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispense_readiness_reviews_org_idx"
  ON "resupply"."dispense_readiness_reviews" ("org_id");
--> statement-breakpoint
-- ── patient_payment_plans ──
ALTER TABLE "resupply"."patient_payment_plans"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_payment_plans"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_payment_plans_org_idx"
  ON "resupply"."patient_payment_plans" ("org_id");
--> statement-breakpoint
-- ── patient_payments ──
ALTER TABLE "resupply"."patient_payments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_payments"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_payments_org_idx"
  ON "resupply"."patient_payments" ("org_id");
--> statement-breakpoint
-- ── patient_autopay_authorizations ──
ALTER TABLE "resupply"."patient_autopay_authorizations"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_autopay_authorizations"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_autopay_authorizations_org_idx"
  ON "resupply"."patient_autopay_authorizations" ("org_id");
--> statement-breakpoint
-- ── prescription_request_packets ──
ALTER TABLE "resupply"."prescription_request_packets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."prescription_request_packets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescription_request_packets_org_idx"
  ON "resupply"."prescription_request_packets" ("org_id");
--> statement-breakpoint
-- ── documentation_packets ──
ALTER TABLE "resupply"."documentation_packets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."documentation_packets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "documentation_packets_org_idx"
  ON "resupply"."documentation_packets" ("org_id");
--> statement-breakpoint
-- ── patient_packets ──
ALTER TABLE "resupply"."patient_packets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packets_org_idx"
  ON "resupply"."patient_packets" ("org_id");
--> statement-breakpoint
-- ── equipment_assets ──
ALTER TABLE "resupply"."equipment_assets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."equipment_assets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_assets_org_idx"
  ON "resupply"."equipment_assets" ("org_id");
--> statement-breakpoint
-- ── patient_maintenance_log ──
ALTER TABLE "resupply"."patient_maintenance_log"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_maintenance_log"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_maintenance_log_org_idx"
  ON "resupply"."patient_maintenance_log" ("org_id");
--> statement-breakpoint
-- ── patient_maintenance_nudges ──
ALTER TABLE "resupply"."patient_maintenance_nudges"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_maintenance_nudges"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_maintenance_nudges_org_idx"
  ON "resupply"."patient_maintenance_nudges" ("org_id");
--> statement-breakpoint
-- ── company_calendar_events ──
ALTER TABLE "resupply"."company_calendar_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."company_calendar_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_calendar_events_org_idx"
  ON "resupply"."company_calendar_events" ("org_id");
--> statement-breakpoint
-- ── patient_identity_verifications ──
ALTER TABLE "resupply"."patient_identity_verifications"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_identity_verifications"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_identity_verifications_org_idx"
  ON "resupply"."patient_identity_verifications" ("org_id");
--> statement-breakpoint
-- ── patient_fit_overrides ──
ALTER TABLE "resupply"."patient_fit_overrides"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_fit_overrides"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_fit_overrides_org_idx"
  ON "resupply"."patient_fit_overrides" ("org_id");
--> statement-breakpoint
-- ── patient_referrals ──
ALTER TABLE "resupply"."patient_referrals"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_referrals"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_referrals_org_idx"
  ON "resupply"."patient_referrals" ("org_id");
--> statement-breakpoint
-- ── patient_form_acknowledgements ──
ALTER TABLE "resupply"."patient_form_acknowledgements"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_form_acknowledgements"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_form_acknowledgements_org_idx"
  ON "resupply"."patient_form_acknowledgements" ("org_id");
--> statement-breakpoint
-- ── cmn_documents ──
ALTER TABLE "resupply"."cmn_documents"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."cmn_documents"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cmn_documents_org_idx"
  ON "resupply"."cmn_documents" ("org_id");
--> statement-breakpoint
-- ── clinical_outreach_log ──
ALTER TABLE "resupply"."clinical_outreach_log"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."clinical_outreach_log"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clinical_outreach_log_org_idx"
  ON "resupply"."clinical_outreach_log" ("org_id");
--> statement-breakpoint
-- ── patient_latest_message ──
ALTER TABLE "resupply"."patient_latest_message"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_latest_message"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_latest_message_org_idx"
  ON "resupply"."patient_latest_message" ("org_id");
--> statement-breakpoint
-- ── signature_tracking ──
ALTER TABLE "resupply"."signature_tracking"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."signature_tracking"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signature_tracking_org_idx"
  ON "resupply"."signature_tracking" ("org_id");
--> statement-breakpoint
-- ── insurance_claim_events ──
ALTER TABLE "resupply"."insurance_claim_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."insurance_claim_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_claim_events_org_idx"
  ON "resupply"."insurance_claim_events" ("org_id");
--> statement-breakpoint
-- ── claim_status_checks ──
ALTER TABLE "resupply"."claim_status_checks"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_status_checks"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_status_checks_org_idx"
  ON "resupply"."claim_status_checks" ("org_id");
--> statement-breakpoint
-- ── claim_appeal_letters ──
ALTER TABLE "resupply"."claim_appeal_letters"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_appeal_letters"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_appeal_letters_org_idx"
  ON "resupply"."claim_appeal_letters" ("org_id");
--> statement-breakpoint
-- ── claim_paperwork_requirements ──
ALTER TABLE "resupply"."claim_paperwork_requirements"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_paperwork_requirements"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_paperwork_requirements_org_idx"
  ON "resupply"."claim_paperwork_requirements" ("org_id");
--> statement-breakpoint
-- ── claim_denial_analyses ──
ALTER TABLE "resupply"."claim_denial_analyses"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_denial_analyses"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_denial_analyses_org_idx"
  ON "resupply"."claim_denial_analyses" ("org_id");
--> statement-breakpoint
-- ── patient_payment_plan_installments ──
ALTER TABLE "resupply"."patient_payment_plan_installments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_payment_plan_installments"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_payment_plan_installments_org_idx"
  ON "resupply"."patient_payment_plan_installments" ("org_id");
--> statement-breakpoint
-- ── shop_returns ──
ALTER TABLE "resupply"."shop_returns"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_returns"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_returns_org_idx"
  ON "resupply"."shop_returns" ("org_id");
--> statement-breakpoint
-- ── shop_reviews ──
ALTER TABLE "resupply"."shop_reviews"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_reviews"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_reviews_org_idx"
  ON "resupply"."shop_reviews" ("org_id");
--> statement-breakpoint
-- ── shop_customer_followups ──
ALTER TABLE "resupply"."shop_customer_followups"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_customer_followups"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customer_followups_org_idx"
  ON "resupply"."shop_customer_followups" ("org_id");
--> statement-breakpoint
-- ── shop_product_questions ──
ALTER TABLE "resupply"."shop_product_questions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_product_questions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_product_questions_org_idx"
  ON "resupply"."shop_product_questions" ("org_id");
--> statement-breakpoint
-- ── shop_customer_push_subscriptions ──
ALTER TABLE "resupply"."shop_customer_push_subscriptions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_customer_push_subscriptions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customer_push_subscriptions_org_idx"
  ON "resupply"."shop_customer_push_subscriptions" ("org_id");
--> statement-breakpoint
-- ── shop_customer_message_template_overrides ──
ALTER TABLE "resupply"."shop_customer_message_template_overrides"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_customer_message_template_overrides"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customer_message_template_overrides_org_idx"
  ON "resupply"."shop_customer_message_template_overrides" ("org_id");
--> statement-breakpoint
-- ── good_faith_estimates ──
ALTER TABLE "resupply"."good_faith_estimates"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."good_faith_estimates"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "good_faith_estimates_org_idx"
  ON "resupply"."good_faith_estimates" ("org_id");
--> statement-breakpoint
-- ── shop_order_loss_claims ──
ALTER TABLE "resupply"."shop_order_loss_claims"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_order_loss_claims"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_loss_claims_org_idx"
  ON "resupply"."shop_order_loss_claims" ("org_id");
--> statement-breakpoint
-- ── shop_subscriptions ──
ALTER TABLE "resupply"."shop_subscriptions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_subscriptions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_subscriptions_org_idx"
  ON "resupply"."shop_subscriptions" ("org_id");
--> statement-breakpoint
-- ── customer_acquisition ──
ALTER TABLE "resupply"."customer_acquisition"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."customer_acquisition"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_acquisition_org_idx"
  ON "resupply"."customer_acquisition" ("org_id");
--> statement-breakpoint
-- ── shop_abandoned_carts ──
ALTER TABLE "resupply"."shop_abandoned_carts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_abandoned_carts"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_abandoned_carts_org_idx"
  ON "resupply"."shop_abandoned_carts" ("org_id");
--> statement-breakpoint
-- ── shop_order_notes ──
ALTER TABLE "resupply"."shop_order_notes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_order_notes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_notes_org_idx"
  ON "resupply"."shop_order_notes" ("org_id");
--> statement-breakpoint
-- ── shop_order_nps_responses ──
ALTER TABLE "resupply"."shop_order_nps_responses"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_order_nps_responses"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_order_nps_responses_org_idx"
  ON "resupply"."shop_order_nps_responses" ("org_id");
--> statement-breakpoint
-- ── mask_fit_outcomes ──
ALTER TABLE "resupply"."mask_fit_outcomes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."mask_fit_outcomes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mask_fit_outcomes_org_idx"
  ON "resupply"."mask_fit_outcomes" ("org_id");
--> statement-breakpoint
-- ── shop_customer_notes ──
ALTER TABLE "resupply"."shop_customer_notes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_customer_notes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_customer_notes_org_idx"
  ON "resupply"."shop_customer_notes" ("org_id");
--> statement-breakpoint
-- ── shop_return_notes ──
ALTER TABLE "resupply"."shop_return_notes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_return_notes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_return_notes_org_idx"
  ON "resupply"."shop_return_notes" ("org_id");
--> statement-breakpoint
-- ── fitter_invites ──
ALTER TABLE "resupply"."fitter_invites"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."fitter_invites"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_invites_org_idx"
  ON "resupply"."fitter_invites" ("org_id");
--> statement-breakpoint
-- ── fitter_campaign_touches ──
ALTER TABLE "resupply"."fitter_campaign_touches"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."fitter_campaign_touches"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_campaign_touches_org_idx"
  ON "resupply"."fitter_campaign_touches" ("org_id");
--> statement-breakpoint
-- ── fitter_campaign_clicks ──
ALTER TABLE "resupply"."fitter_campaign_clicks"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."fitter_campaign_clicks"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_campaign_clicks_org_idx"
  ON "resupply"."fitter_campaign_clicks" ("org_id");
--> statement-breakpoint
-- ── voice_calls ──
ALTER TABLE "resupply"."voice_calls"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."voice_calls"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_calls_org_idx"
  ON "resupply"."voice_calls" ("org_id");
--> statement-breakpoint
-- ── voice_reorder_sessions ──
ALTER TABLE "resupply"."voice_reorder_sessions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."voice_reorder_sessions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_reorder_sessions_org_idx"
  ON "resupply"."voice_reorder_sessions" ("org_id");
--> statement-breakpoint
-- ── conversation_coaching_notes ──
ALTER TABLE "resupply"."conversation_coaching_notes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."conversation_coaching_notes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversation_coaching_notes_org_idx"
  ON "resupply"."conversation_coaching_notes" ("org_id");
--> statement-breakpoint
-- ── inbound_faxes ──
ALTER TABLE "resupply"."inbound_faxes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."inbound_faxes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_faxes_org_idx"
  ON "resupply"."inbound_faxes" ("org_id");
--> statement-breakpoint
-- ── referral_reviews ──
ALTER TABLE "resupply"."referral_reviews"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."referral_reviews"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_reviews_org_idx"
  ON "resupply"."referral_reviews" ("org_id");
--> statement-breakpoint
-- ── patient_packet_documents ──
ALTER TABLE "resupply"."patient_packet_documents"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packet_documents"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packet_documents_org_idx"
  ON "resupply"."patient_packet_documents" ("org_id");
--> statement-breakpoint
-- ── patient_packet_signatures ──
ALTER TABLE "resupply"."patient_packet_signatures"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packet_signatures"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packet_signatures_org_idx"
  ON "resupply"."patient_packet_signatures" ("org_id");
--> statement-breakpoint
-- ── manual_documents ──
ALTER TABLE "resupply"."manual_documents"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."manual_documents"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manual_documents_org_idx"
  ON "resupply"."manual_documents" ("org_id");
--> statement-breakpoint
-- ── manual_document_packets ──
ALTER TABLE "resupply"."manual_document_packets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."manual_document_packets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manual_document_packets_org_idx"
  ON "resupply"."manual_document_packets" ("org_id");
--> statement-breakpoint
-- ── csr_order_requests ──
ALTER TABLE "resupply"."csr_order_requests"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."csr_order_requests"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csr_order_requests_org_idx"
  ON "resupply"."csr_order_requests" ("org_id");
--> statement-breakpoint
-- ── bulk_campaigns ──
ALTER TABLE "resupply"."bulk_campaigns"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."bulk_campaigns"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bulk_campaigns_org_idx"
  ON "resupply"."bulk_campaigns" ("org_id");
--> statement-breakpoint
-- ── bulk_campaign_recipients ──
ALTER TABLE "resupply"."bulk_campaign_recipients"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."bulk_campaign_recipients"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bulk_campaign_recipients_org_idx"
  ON "resupply"."bulk_campaign_recipients" ("org_id");
--> statement-breakpoint
-- ── csr_shifts ──
ALTER TABLE "resupply"."csr_shifts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."csr_shifts"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csr_shifts_org_idx"
  ON "resupply"."csr_shifts" ("org_id");
--> statement-breakpoint
-- ── report_presets ──
ALTER TABLE "resupply"."report_presets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."report_presets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_presets_org_idx"
  ON "resupply"."report_presets" ("org_id");
--> statement-breakpoint
-- ── office_closures ──
ALTER TABLE "resupply"."office_closures"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."office_closures"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_closures_org_idx"
  ON "resupply"."office_closures" ("org_id");
--> statement-breakpoint
-- ── office_recurring_closures ──
ALTER TABLE "resupply"."office_recurring_closures"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."office_recurring_closures"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_recurring_closures_org_idx"
  ON "resupply"."office_recurring_closures" ("org_id");
--> statement-breakpoint
-- ── office_hours ──
ALTER TABLE "resupply"."office_hours"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."office_hours"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "office_hours_org_idx"
  ON "resupply"."office_hours" ("org_id");
--> statement-breakpoint
-- ── locations ──
ALTER TABLE "resupply"."locations"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."locations"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_org_idx"
  ON "resupply"."locations" ("org_id");
--> statement-breakpoint
-- ── gl_account_mappings ──
ALTER TABLE "resupply"."gl_account_mappings"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."gl_account_mappings"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gl_account_mappings_org_idx"
  ON "resupply"."gl_account_mappings" ("org_id");
--> statement-breakpoint
-- ── shop_backorders ──
ALTER TABLE "resupply"."shop_backorders"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_backorders"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_backorders_org_idx"
  ON "resupply"."shop_backorders" ("org_id");
--> statement-breakpoint
-- ── shop_sku_substitutes ──
ALTER TABLE "resupply"."shop_sku_substitutes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_sku_substitutes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_sku_substitutes_org_idx"
  ON "resupply"."shop_sku_substitutes" ("org_id");
--> statement-breakpoint
-- ── frequency_rules ──
ALTER TABLE "resupply"."frequency_rules"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."frequency_rules"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "frequency_rules_org_idx"
  ON "resupply"."frequency_rules" ("org_id");
--> statement-breakpoint
-- ── compliance_rules ──
ALTER TABLE "resupply"."compliance_rules"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."compliance_rules"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compliance_rules_org_idx"
  ON "resupply"."compliance_rules" ("org_id");
--> statement-breakpoint
-- ── inventory_reconciliation_lines ──
ALTER TABLE "resupply"."inventory_reconciliation_lines"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."inventory_reconciliation_lines"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_reconciliation_lines_org_idx"
  ON "resupply"."inventory_reconciliation_lines" ("org_id");
--> statement-breakpoint
-- ── low_stock_alert_state ──
ALTER TABLE "resupply"."low_stock_alert_state"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."low_stock_alert_state"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "low_stock_alert_state_org_idx"
  ON "resupply"."low_stock_alert_state" ("org_id");
--> statement-breakpoint
-- ── shop_product_compatibility ──
ALTER TABLE "resupply"."shop_product_compatibility"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_product_compatibility"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_product_compatibility_org_idx"
  ON "resupply"."shop_product_compatibility" ("org_id");
--> statement-breakpoint
-- ── equipment_recalls ──
ALTER TABLE "resupply"."equipment_recalls"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."equipment_recalls"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_recalls_org_idx"
  ON "resupply"."equipment_recalls" ("org_id");
--> statement-breakpoint
-- ── recall_remediation_actions ──
ALTER TABLE "resupply"."recall_remediation_actions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."recall_remediation_actions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recall_remediation_actions_org_idx"
  ON "resupply"."recall_remediation_actions" ("org_id");
--> statement-breakpoint
-- ── clearinghouse_credentials ──
ALTER TABLE "resupply"."clearinghouse_credentials"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."clearinghouse_credentials"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clearinghouse_credentials_org_idx"
  ON "resupply"."clearinghouse_credentials" ("org_id");
--> statement-breakpoint
-- ── clearinghouse_inbound_files ──
ALTER TABLE "resupply"."clearinghouse_inbound_files"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."clearinghouse_inbound_files"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clearinghouse_inbound_files_org_idx"
  ON "resupply"."clearinghouse_inbound_files" ("org_id");
--> statement-breakpoint
-- ── payer_modifier_rules ──
ALTER TABLE "resupply"."payer_modifier_rules"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."payer_modifier_rules"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_modifier_rules_org_idx"
  ON "resupply"."payer_modifier_rules" ("org_id");
--> statement-breakpoint
-- ── webhook_subscriptions ──
ALTER TABLE "resupply"."webhook_subscriptions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."webhook_subscriptions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_org_idx"
  ON "resupply"."webhook_subscriptions" ("org_id");
--> statement-breakpoint
-- ── webhook_deliveries ──
ALTER TABLE "resupply"."webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."webhook_deliveries"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_org_idx"
  ON "resupply"."webhook_deliveries" ("org_id");
--> statement-breakpoint
-- ── video_visits ──
ALTER TABLE "resupply"."video_visits"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."video_visits"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "video_visits_org_idx"
  ON "resupply"."video_visits" ("org_id");
