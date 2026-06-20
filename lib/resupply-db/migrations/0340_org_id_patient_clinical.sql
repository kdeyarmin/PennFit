-- 0337_org_id_patient_clinical — multi-tenant org_id backfill,
-- follow-up batch (patient-clinical / notes tables missed by the
-- original 0331–0336 batches). Phase 0, plan workstream A2.
--
-- These are all clearly patient-scoped (each carries patient_id) and so
-- tenant-scoped, but were not in the first backfill pass. Cutting their
-- reader routes (patient-resupply-summary, patient-timeline, …) over to
-- getOrgScopedClient is blocked until they carry org_id, because the
-- scoped client auto-applies `.eq("org_id", …)`.
--
-- Identical safe additive shape to 0332 (patient core): NULLABLE org_id
-- + backfill to the seed tenant (slug 'penn-home-medical') + FK +
-- per-table index. No existing INSERT breaks (nullable), nothing
-- reads/filters org_id yet (no behavior change). NOT NULL tightening +
-- scoped-wrapper cutover land in each domain's cutover PR.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── patient_smart_trigger_events ────────────────────────────────────
ALTER TABLE "resupply"."patient_smart_trigger_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_smart_trigger_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_smart_trigger_events_org_idx"
  ON "resupply"."patient_smart_trigger_events" ("org_id");
--> statement-breakpoint

-- ── csr_compliance_alerts ───────────────────────────────────────────
ALTER TABLE "resupply"."csr_compliance_alerts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."csr_compliance_alerts"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "csr_compliance_alerts_org_idx"
  ON "resupply"."csr_compliance_alerts" ("org_id");
--> statement-breakpoint

-- ── patient_address_history ─────────────────────────────────────────
ALTER TABLE "resupply"."patient_address_history"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_address_history"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_address_history_org_idx"
  ON "resupply"."patient_address_history" ("org_id");
--> statement-breakpoint

-- ── patient_coaching_plans ──────────────────────────────────────────
ALTER TABLE "resupply"."patient_coaching_plans"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_coaching_plans"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_coaching_plans_org_idx"
  ON "resupply"."patient_coaching_plans" ("org_id");
--> statement-breakpoint

-- ── recall_notifications ────────────────────────────────────────────
ALTER TABLE "resupply"."recall_notifications"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."recall_notifications"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recall_notifications_org_idx"
  ON "resupply"."recall_notifications" ("org_id");
--> statement-breakpoint

-- ── patient_notes ───────────────────────────────────────────────────
ALTER TABLE "resupply"."patient_notes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_notes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_notes_org_idx"
  ON "resupply"."patient_notes" ("org_id");
--> statement-breakpoint

-- ── patient_followups ───────────────────────────────────────────────
ALTER TABLE "resupply"."patient_followups"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_followups"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_followups_org_idx"
  ON "resupply"."patient_followups" ("org_id");
--> statement-breakpoint

-- ── patient_therapy_milestones ──────────────────────────────────────
ALTER TABLE "resupply"."patient_therapy_milestones"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_therapy_milestones"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_therapy_milestones_org_idx"
  ON "resupply"."patient_therapy_milestones" ("org_id");
