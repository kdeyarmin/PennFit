-- 0326_org_id_patient_core — multi-tenant org_id backfill, batch 1 of N
-- (patient core). Phase 0, plan workstream A2.
--
-- See docs/multi-tenant-phase-0-engineering-plan-2026-06-14.md.
--
-- Adds the tenant anchor `org_id` to the patient-core tables and
-- backfills every existing row to the seed tenant (migration 0325,
-- slug 'penn-home-medical'). This is the FIRST domain batch; the
-- remaining batches (comms, fulfillment/shop, billing/claims, staff/
-- config, analytics) follow the identical shape.
--
-- WHY org_id IS NULLABLE HERE (deliberate, not an oversight)
--   A NOT NULL column with no default would break every existing
--   INSERT that doesn't yet supply org_id — and the application insert
--   paths don't set it until the org-scoped query wrapper is cut over
--   (Phase 0 workstream C). So this migration is purely ADDITIVE:
--     * column nullable  → existing inserts keep working unchanged,
--     * existing rows backfilled → no row is left untagged,
--     * FK + index in place → ready for scoped reads.
--   The NOT NULL tightening lands in the cutover PR for this domain,
--   AFTER the insert paths inject org_id. Nothing reads/filters on
--   org_id yet, so there is no behavior change in this slice.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent
-- (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, guarded
-- backfill).

-- Resolve the seed tenant id once into a temp setting is overkill for
-- a flat SQL file; instead each backfill uses the slug subquery. The
-- subquery is cheap (unique index on organizations.slug) and keeps the
-- statements independently re-runnable.

-- ── patients ────────────────────────────────────────────────────────
ALTER TABLE "resupply"."patients"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patients"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_org_idx"
  ON "resupply"."patients" ("org_id");
--> statement-breakpoint

-- ── prescriptions ───────────────────────────────────────────────────
ALTER TABLE "resupply"."prescriptions"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."prescriptions"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prescriptions_org_idx"
  ON "resupply"."prescriptions" ("org_id");
--> statement-breakpoint

-- ── episodes ────────────────────────────────────────────────────────
ALTER TABLE "resupply"."episodes"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."episodes"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episodes_org_idx"
  ON "resupply"."episodes" ("org_id");
--> statement-breakpoint

-- ── fulfillments ────────────────────────────────────────────────────
ALTER TABLE "resupply"."fulfillments"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."fulfillments"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fulfillments_org_idx"
  ON "resupply"."fulfillments" ("org_id");
--> statement-breakpoint

-- ── patient_documents ───────────────────────────────────────────────
ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_documents"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_documents_org_idx"
  ON "resupply"."patient_documents" ("org_id");
--> statement-breakpoint

-- ── patient_onboarding_journeys ─────────────────────────────────────
ALTER TABLE "resupply"."patient_onboarding_journeys"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_onboarding_journeys"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_onboarding_journeys_org_idx"
  ON "resupply"."patient_onboarding_journeys" ("org_id");
--> statement-breakpoint

-- ── patient_therapy_links ───────────────────────────────────────────
ALTER TABLE "resupply"."patient_therapy_links"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_therapy_links"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_therapy_links_org_idx"
  ON "resupply"."patient_therapy_links" ("org_id");
--> statement-breakpoint

-- ── patient_therapy_nights ──────────────────────────────────────────
ALTER TABLE "resupply"."patient_therapy_nights"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."patient_therapy_nights"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_therapy_nights_org_idx"
  ON "resupply"."patient_therapy_nights" ("org_id");
