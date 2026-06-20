-- 0339_org_id_stragglers — multi-tenant org_id backfill, STRAGGLER batch.
-- Phase 0, plan workstream A2 (gap-patch after the 0338 completion sweep).
--
-- A direct re-inventory of the live resupply schema (every base table
-- still lacking org_id) found a tail of row-level tenant-scoped tables
-- the 0331-0338 batches missed. This adds org_id to all of them so the
-- additive backfill of *row-level* tenant data is complete.
--
-- INCLUDED (this file): row-level tenant records (one row per patient /
-- customer / case / claim / signature request), their child tables
-- (case_links, outreach_playbook_step_log/steps, provider_signature_events),
-- and per-org config (outreach_playbooks, business_targets, the
-- patient_packet_* presets/template overrides+revisions,
-- shop_back_in_stock_notifications).
--
-- DELIBERATELY EXCLUDED:
--   * patient_grievances — retired-compliance table (migration 0156),
--     0 rows, no writers; the "no compliance machinery" hard rule.
--   * Grain-keyed AGGREGATE / counter tables (metrics_daily,
--     therapy_fleet_daily_metrics, fitter_campaign_touch_metrics +
--     _variant_metrics, payer_estimate_stats, integration_run_health,
--     control_number_counters). Their primary key is a non-tenant
--     dimension (date / payer slug / touch_index / adapter key / pool),
--     so per-tenant scoping is a PK/grain REDESIGN + recompute, not an
--     additive nullable column — deferred to the Phase-1 analytics
--     multitenancy workstream.
--   * Provider identity (providers, providers_pecos_status,
--     provider_portal_accounts, provider_mfa_*) and FHIR jti cache —
--     providers are cross-org global directory rows.
--   * admin_mfa_* — pending the "are admins single-org?" decision.
--   * System/audit (audit_log, *_events, idempotency_keys, worker_*,
--     stripe_webhook_events, object_storage_acls) and global reference
--     catalogs (hcpcs_codes, denial_codes, education_videos,
--     product_costs, *_hcpcs_map) — correctly stay unscoped.
--   * organizations (the tenant directory itself) and
--     dme_organization_contacts (already organization_id-keyed).
--
-- Identical safe additive shape to 0332/0337/0338: NULLABLE org_id +
-- backfill to the seed tenant + FK + per-table index. No existing
-- INSERT breaks, nothing reads/filters org_id yet. Per ADR 003.

-- ── asset_recovery_cases ──
ALTER TABLE "resupply"."asset_recovery_cases"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."asset_recovery_cases"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_recovery_cases_org_idx"
  ON "resupply"."asset_recovery_cases" ("org_id");
--> statement-breakpoint
-- ── cases ──
ALTER TABLE "resupply"."cases"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."cases"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cases_org_idx"
  ON "resupply"."cases" ("org_id");
--> statement-breakpoint
-- ── clinical_encounters ──
ALTER TABLE "resupply"."clinical_encounters"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."clinical_encounters"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clinical_encounters_org_idx"
  ON "resupply"."clinical_encounters" ("org_id");
--> statement-breakpoint
-- ── outreach_playbook_runs ──
ALTER TABLE "resupply"."outreach_playbook_runs"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."outreach_playbook_runs"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_playbook_runs_org_idx"
  ON "resupply"."outreach_playbook_runs" ("org_id");
--> statement-breakpoint
-- ── patient_payment_claim_applications ──
ALTER TABLE "resupply"."patient_payment_claim_applications"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_payment_claim_applications"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_payment_claim_applications_org_idx"
  ON "resupply"."patient_payment_claim_applications" ("org_id");
--> statement-breakpoint
-- ── patient_worklist_actions ──
ALTER TABLE "resupply"."patient_worklist_actions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_worklist_actions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_worklist_actions_org_idx"
  ON "resupply"."patient_worklist_actions" ("org_id");
--> statement-breakpoint
-- ── provider_signature_requests ──
ALTER TABLE "resupply"."provider_signature_requests"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."provider_signature_requests"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_requests_org_idx"
  ON "resupply"."provider_signature_requests" ("org_id");
--> statement-breakpoint
-- ── setup_checklist_items ──
ALTER TABLE "resupply"."setup_checklist_items"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."setup_checklist_items"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "setup_checklist_items_org_idx"
  ON "resupply"."setup_checklist_items" ("org_id");
--> statement-breakpoint
-- ── therapy_fleet_alerts ──
ALTER TABLE "resupply"."therapy_fleet_alerts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."therapy_fleet_alerts"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "therapy_fleet_alerts_org_idx"
  ON "resupply"."therapy_fleet_alerts" ("org_id");
--> statement-breakpoint
-- ── case_links ──
ALTER TABLE "resupply"."case_links"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."case_links"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "case_links_org_idx"
  ON "resupply"."case_links" ("org_id");
--> statement-breakpoint
-- ── outreach_playbook_step_log ──
ALTER TABLE "resupply"."outreach_playbook_step_log"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."outreach_playbook_step_log"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_playbook_step_log_org_idx"
  ON "resupply"."outreach_playbook_step_log" ("org_id");
--> statement-breakpoint
-- ── outreach_playbook_steps ──
ALTER TABLE "resupply"."outreach_playbook_steps"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."outreach_playbook_steps"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_playbook_steps_org_idx"
  ON "resupply"."outreach_playbook_steps" ("org_id");
--> statement-breakpoint
-- ── provider_signature_events ──
ALTER TABLE "resupply"."provider_signature_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."provider_signature_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_signature_events_org_idx"
  ON "resupply"."provider_signature_events" ("org_id");
--> statement-breakpoint
-- ── outreach_playbooks ──
ALTER TABLE "resupply"."outreach_playbooks"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."outreach_playbooks"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_playbooks_org_idx"
  ON "resupply"."outreach_playbooks" ("org_id");
--> statement-breakpoint
-- ── shop_back_in_stock_notifications ──
ALTER TABLE "resupply"."shop_back_in_stock_notifications"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."shop_back_in_stock_notifications"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shop_back_in_stock_notifications_org_idx"
  ON "resupply"."shop_back_in_stock_notifications" ("org_id");
--> statement-breakpoint
-- ── business_targets ──
ALTER TABLE "resupply"."business_targets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."business_targets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_targets_org_idx"
  ON "resupply"."business_targets" ("org_id");
--> statement-breakpoint
-- ── patient_packet_presets ──
ALTER TABLE "resupply"."patient_packet_presets"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packet_presets"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packet_presets_org_idx"
  ON "resupply"."patient_packet_presets" ("org_id");
--> statement-breakpoint
-- ── patient_packet_template_overrides ──
ALTER TABLE "resupply"."patient_packet_template_overrides"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packet_template_overrides"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packet_template_overrides_org_idx"
  ON "resupply"."patient_packet_template_overrides" ("org_id");
--> statement-breakpoint
-- ── patient_packet_template_revisions ──
ALTER TABLE "resupply"."patient_packet_template_revisions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_packet_template_revisions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_packet_template_revisions_org_idx"
  ON "resupply"."patient_packet_template_revisions" ("org_id");
