-- 0192_admin_availability — Phase 1 (CSR #16): agent availability toggle.
--
-- Adds admin_users.availability so a rep can mark themselves away /
-- do-not-assign (e.g. on a break, or buried in a complex call). The
-- skill-router (lib/routing/auto-assign.ts) then skips anyone who isn't
-- 'available' when auto-assigning conversations. NOT NULL DEFAULT
-- backfills every existing row to 'available', so behavior is unchanged
-- until a rep flips their own status.
--
-- Additive. Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."admin_users"
  ADD COLUMN IF NOT EXISTS "availability" text NOT NULL DEFAULT 'available';
--> statement-breakpoint

ALTER TABLE "resupply"."admin_users"
  DROP CONSTRAINT IF EXISTS "admin_users_availability_enum";
--> statement-breakpoint
ALTER TABLE "resupply"."admin_users"
  ADD CONSTRAINT "admin_users_availability_enum"
  CHECK ("availability" IN ('available', 'away', 'do_not_assign'));
