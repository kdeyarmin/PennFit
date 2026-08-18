-- 0498_safety_screen_one_active_per_org — the missing half of a guard.
--
-- 0484 enforced "at most one active question set per family" for the
-- PLATFORM rows only:
--
--   CREATE UNIQUE INDEX safety_screen_versions_one_active_idx
--     ON safety_screen_versions (slug) WHERE org_id IS NULL AND status = 'active';
--
-- Tenant-owned sets had no equivalent, which did not matter while nothing
-- could create one — there was no admin route, so the only rows in the
-- table came from the seed. Now that a tenant can publish its own set, two
-- active rows for the same family become reachable, and `loadSafetyScreen`
-- resolves them with `.limit(1)` after ordering by `org_id` alone. Between
-- two tenant rows that ordering is not a tie-break, so the screen a patient
-- was shown would be whichever row Postgres happened to return.
--
-- For a screen whose whole job is to decide when a magnetic mask is unsafe,
-- "whichever row came back" is not an acceptable resolution rule. The
-- publish path in routes/admin/safety-screens.ts retires the previous
-- active set in the same operation; this index is what makes that a
-- guarantee rather than an intention.
--
-- Safe to add to existing data: no tenant-owned rows exist yet (the table
-- has only 0484's platform seed), so the index cannot fail on a duplicate.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE UNIQUE INDEX IF NOT EXISTS "safety_screen_versions_one_active_org_idx"
  ON "resupply"."safety_screen_versions" ("org_id", "slug")
  WHERE "org_id" IS NOT NULL AND "status" = 'active';
