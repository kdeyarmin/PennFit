-- 0143_era_payer_profile_link — add payer_profile_id to era_files so
-- the ERA reconciler can persist which payer profile the 835 came
-- from. Phase 12 (mig 0142) added `era_payer_id` on payer_profiles
-- but no code path used it yet; this migration + the
-- resolvePayerProfileForEra helper close that loop.
--
-- The link is informational, not a strict FK at the application
-- layer: an 835 with an unknown payer ID still ingests successfully
-- with payer_profile_id=NULL and shows up in the dashboard as
-- "unknown payer — update the catalog" so ops can backfill the
-- catalog entry.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."era_files"
  ADD COLUMN IF NOT EXISTS "payer_profile_id" uuid
    REFERENCES "resupply"."payer_profiles"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "era_files_payer_profile_idx"
  ON "resupply"."era_files" ("payer_profile_id")
  WHERE "payer_profile_id" IS NOT NULL;
--> statement-breakpoint
