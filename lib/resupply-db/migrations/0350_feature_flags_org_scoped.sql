-- 0350_feature_flags_org_scoped — Phase 1: per-tenant feature flags.
--
-- Re-keys resupply.feature_flags from a global (key) PRIMARY KEY to a
-- per-tenant (org_id, key) shape so each DME (tenant) toggles features
-- independently, completing the anchor that migration 0336 added
-- ("feature_flags / app_config carry org_id now but stay GLOBAL until
-- Phase 1 re-keys them to (org_id, key)").
--
-- Production preservation: 0336 already backfilled every existing row's
-- org_id to the seed tenant ('penn-home-medical'), so the rekey is a
-- pure constraint change for the live single-tenant deployment — the
-- effective values are unchanged. The runtime reader
-- (artifacts/resupply-api/src/lib/feature-flags.ts) resolves the seed
-- org when no org context is supplied, so the ~74 existing
-- isFeatureEnabled(key) call sites keep returning the same answers.
--
-- New tenants: provisioned a full set of rows by `tenant:onboard`
-- (copied from the seed org). The reader also falls back to the seed
-- org's value for any (org, key) a tenant hasn't got a row for, so a
-- not-yet-provisioned org still reads sane platform defaults.
--
-- IMPORTANT for future migrations: after this rekey, a migration that
-- seeds a NEW flag must target the seed org and conflict on the
-- composite key, e.g.:
--   INSERT INTO resupply.feature_flags (org_id, key, enabled, description, category)
--   SELECT id, 'my.flag', true, '…', '…' FROM resupply.organizations
--   WHERE slug = 'penn-home-medical'
--   ON CONFLICT (org_id, key) DO NOTHING;
-- (A bare `ON CONFLICT (key)` no longer has a matching unique constraint.)
-- A fresh full replay is safe: the historical key-PK seed migrations run
-- BEFORE this one, so their `ON CONFLICT (key)` still matches at that point.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── feature_flags: backfill any stragglers, then enforce + rekey ──────
-- Defensive re-backfill: flag-seed migrations that ran AFTER 0336 insert
-- rows without an org_id, leaving them NULL. Re-anchor them to the seed
-- org before enforcing NOT NULL so the rekey can't fail on a stray null.
UPDATE "resupply"."feature_flags"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."feature_flags"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint

-- Swap the PRIMARY KEY from (key) to (org_id, key). Guarded so a re-run
-- (or a fresh DB where this already landed) is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'resupply'
      AND t.relname = 'feature_flags'
      AND c.contype = 'p'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      ) = ARRAY['key', 'org_id']
  ) THEN
    ALTER TABLE "resupply"."feature_flags"
      DROP CONSTRAINT IF EXISTS "feature_flags_pkey";
    ALTER TABLE "resupply"."feature_flags"
      ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("org_id", "key");
  END IF;
END $$;
--> statement-breakpoint

-- ── feature_flag_events: carry org_id so the Control Center's "recent
--    toggle activity" panel is per-tenant. ────────────────────────────
ALTER TABLE "resupply"."feature_flag_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint

UPDATE "resupply"."feature_flag_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feature_flag_events_org_idx"
  ON "resupply"."feature_flag_events" ("org_id", "occurred_at" DESC);
