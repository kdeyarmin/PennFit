-- 0244_fitter_invites_claim — "holding area" claim ownership for
-- completed-but-unattached fitter invites.
--
-- When a prospect (not yet a patient) finishes an invited fitting and
-- the recipient email/phone matched no chart, the row sits unattached
-- in the holding area (status='completed', patient_id IS NULL). Before
-- an employee resolves it — attach to an existing chart or build a new
-- one — they "claim" it so two staff don't work the same fitting.
--
-- Claim is advisory ownership, not a lock: any staffer can release it,
-- and the audit log records who claimed/released. Cleared when the
-- fitting is attached.
--
-- Plain columns — service-role only, no RLS. Per ADR 003 — versioned
-- hand-authored migration.

ALTER TABLE "resupply"."fitter_invites"
  ADD COLUMN IF NOT EXISTS "claimed_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "claimed_by_email" text,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;
--> statement-breakpoint
-- Holding-area scan: completed fittings with no chart yet, newest
-- first. Partial index keeps it tight (most rows are attached or
-- still in flight).
CREATE INDEX IF NOT EXISTS "fitter_invites_holding_idx"
  ON "resupply"."fitter_invites" ("created_at" DESC)
  WHERE "status" = 'completed' AND "patient_id" IS NULL;
