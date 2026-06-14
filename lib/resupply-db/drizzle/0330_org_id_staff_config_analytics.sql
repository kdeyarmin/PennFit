-- 0330_org_id_staff_config_analytics — multi-tenant org_id backfill,
-- batch 5 of 5 (staff / config / analytics). Phase 0, plan workstream A2.
--
-- See 0326 (batch 1) for the full rationale. Identical safe additive
-- shape: NULLABLE org_id + backfill to the seed tenant
-- (slug 'penn-home-medical') + FK + per-table index. No existing INSERT
-- breaks (nullable), nothing reads/filters org_id yet (no behavior
-- change). NOT NULL tightening + scoped-wrapper cutover land in the
-- cutover PR.
--
-- This is the LAST additive backfill batch; after it every
-- tenant-scoped table carries org_id and the enforcement work (wrapper
-- cutover, NOT NULL, RLS policies, guard -> FAIL, cross-tenant leakage
-- test) can begin.
--
-- NOTES
--   * admin_users.org_id: once backfilled, requireAdmin's org resolution
--     switches from the seed-org fallback to reading this column per
--     staff member (Phase 0 workstream B follow-up).
--   * feature_flags / app_config carry org_id now but stay GLOBAL until
--     Phase 1 re-keys them to (org_id, key); this slice only adds the
--     anchor column.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── admin_users ─────────────────────────────────────────────────────
ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."admin_users"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_users_org_idx"
  ON "resupply"."admin_users" ("org_id");
--> statement-breakpoint

-- ── feature_flags ───────────────────────────────────────────────────
ALTER TABLE "resupply"."feature_flags"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."feature_flags"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flags_org_idx"
  ON "resupply"."feature_flags" ("org_id");
--> statement-breakpoint

-- ── app_config ──────────────────────────────────────────────────────
ALTER TABLE "resupply"."app_config"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."app_config"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_config_org_idx"
  ON "resupply"."app_config" ("org_id");
--> statement-breakpoint

-- ── payer_profiles ──────────────────────────────────────────────────
ALTER TABLE "resupply"."payer_profiles"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."payer_profiles"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_profiles_org_idx"
  ON "resupply"."payer_profiles" ("org_id");
--> statement-breakpoint

-- ── payer_fee_schedules ─────────────────────────────────────────────
ALTER TABLE "resupply"."payer_fee_schedules"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."payer_fee_schedules"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payer_fee_schedules_org_idx"
  ON "resupply"."payer_fee_schedules" ("org_id");
--> statement-breakpoint

-- ── claim_scrub_results ─────────────────────────────────────────────
ALTER TABLE "resupply"."claim_scrub_results"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."claim_scrub_results"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_scrub_results_org_idx"
  ON "resupply"."claim_scrub_results" ("org_id");
--> statement-breakpoint

-- ── patient_checkin_attempts ────────────────────────────────────────
ALTER TABLE "resupply"."patient_checkin_attempts"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_checkin_attempts"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_checkin_attempts_org_idx"
  ON "resupply"."patient_checkin_attempts" ("org_id");
--> statement-breakpoint

-- ── fitter_leads ────────────────────────────────────────────────────
ALTER TABLE "resupply"."fitter_leads"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."fitter_leads"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fitter_leads_org_idx"
  ON "resupply"."fitter_leads" ("org_id");
--> statement-breakpoint

-- ── insurance_leads ─────────────────────────────────────────────────
ALTER TABLE "resupply"."insurance_leads"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."insurance_leads"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_leads_org_idx"
  ON "resupply"."insurance_leads" ("org_id");
