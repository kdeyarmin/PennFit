-- 0352_app_config_org_scoped — Phase 1: per-tenant app_config.
--
-- Re-keys resupply.app_config from a global (key) PRIMARY KEY to a
-- per-tenant (org_id, key) shape so each DME (tenant) can store its own
-- configuration values independently, completing the anchor that
-- migration 0336 added ("feature_flags / app_config carry org_id now but
-- stay GLOBAL until Phase 1 re-keys them to (org_id, key)"). This is the
-- app_config counterpart of 0350's feature_flags rekey.
--
-- Production preservation: 0336 already backfilled every existing row's
-- org_id to the seed tenant ('penn-home-medical') and 0351 set it
-- NOT NULL, so the rekey is a pure constraint change for the live
-- single-tenant deployment — the effective values are unchanged. The
-- runtime paths are already org-scoped:
--   * the boot overlay (app-config/store.ts) reads through
--     getOrgScopedClient(resolveSeedOrgId()).from("app_config"), i.e. the
--     seed org's rows = the platform defaults, and
--   * the admin write route (routes/admin/app-config.ts) upserts through
--     getOrgScopedClient(req.orgId), i.e. the admin's own tenant.
-- The (key) PK was the only thing forcing a single global row per key;
-- lifting it to (org_id, key) lets a second tenant hold its own row for
-- the same key without colliding.
--
-- IMPORTANT for future migrations: after this rekey, a migration that
-- seeds an app_config row must target the seed org and conflict on the
-- composite key, e.g.:
--   INSERT INTO resupply.app_config (org_id, key, value)
--   SELECT id, 'MY_KEY', 'val' FROM resupply.organizations
--   WHERE slug = 'penn-home-medical'
--   ON CONFLICT (org_id, key) DO NOTHING;
-- (A bare `ON CONFLICT (key)` no longer has a matching unique constraint;
-- the admin route's upsert is updated to onConflict "org_id,key" in the
-- same change.) A fresh full replay is safe: the historical key-PK seed
-- migrations run BEFORE this one, so their `ON CONFLICT (key)` still
-- matches at that point.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── app_config: backfill any stragglers, then enforce + rekey ─────────
-- Defensive re-backfill: any app_config-seed migration that ran AFTER
-- 0336 inserts rows without an org_id, leaving them NULL. Re-anchor them
-- to the seed org before enforcing NOT NULL so the rekey can't fail on a
-- stray null.
UPDATE "resupply"."app_config"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

ALTER TABLE "resupply"."app_config"
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
      AND t.relname = 'app_config'
      AND c.contype = 'p'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      ) = ARRAY['key', 'org_id']
  ) THEN
    ALTER TABLE "resupply"."app_config"
      DROP CONSTRAINT IF EXISTS "app_config_pkey";
    ALTER TABLE "resupply"."app_config"
      ADD CONSTRAINT "app_config_pkey" PRIMARY KEY ("org_id", "key");
  END IF;
END $$;
--> statement-breakpoint

-- ── app_config_events: carry org_id so the System Config console's
--    "Recent activity" panel is per-tenant (a tenant admin must not see
--    WHICH keys another tenant changed). ───────────────────────────────
ALTER TABLE "resupply"."app_config_events"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint

UPDATE "resupply"."app_config_events"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "app_config_events_org_idx"
  ON "resupply"."app_config_events" ("org_id", "occurred_at" DESC);
