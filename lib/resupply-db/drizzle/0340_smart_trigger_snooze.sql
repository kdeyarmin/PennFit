-- 0340 — snooze support for smart-trigger events.
--
-- The Clinical Insights report (/admin/therapy-fleet/clinical-insights)
-- is the RT team's queue of active clinical signals. Until now the only
-- triage action was DISMISS (permanent: dismissed_at). Snooze adds the
-- middle ground an RT actually needs: "not a false positive, but I've
-- looked — re-surface it in a week." A snoozed event stays in the table
-- (so it still blocks a duplicate re-fire via the active-unique index)
-- but drops out of the report's active list until snoozed_until passes.
--
-- Two nullable columns, no backfill, no rewrite:
--   * snoozed_until    — when the event should re-surface (NULL = not snoozed)
--   * snoozed_by_email — who snoozed it (audit-adjacent, admin-only)
--
-- The report query filters `snoozed_until IS NULL OR snoozed_until < now()`
-- so an elapsed snooze automatically re-appears. Dismiss still wins:
-- dismissed_at takes a row out permanently regardless of snooze.
--
-- Journal posture (per CLAUDE.md): NOT added to meta/_journal.json;
-- migrate.mjs dedups by file hash and runs each SQL once. Additive +
-- IF NOT EXISTS, so a re-run / forward-deploy is a no-op.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patient_smart_trigger_events"
  ADD COLUMN IF NOT EXISTS "snoozed_until" timestamptz;
--> statement-breakpoint

ALTER TABLE "resupply"."patient_smart_trigger_events"
  ADD COLUMN IF NOT EXISTS "snoozed_by_email" text;
--> statement-breakpoint

-- Partial index over rows with a live snooze — the report's "active"
-- filter checks this, and the set is small (only currently-snoozed
-- events), so the index stays tiny.
CREATE INDEX IF NOT EXISTS "patient_smart_trigger_events_snoozed_until_idx"
  ON "resupply"."patient_smart_trigger_events" ("snoozed_until")
  WHERE "snoozed_until" IS NOT NULL;
