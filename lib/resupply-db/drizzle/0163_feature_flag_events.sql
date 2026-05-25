-- feature_flag_events — append-only log of feature-flag toggles.
--
-- Background: the admin Control Center's "Recent toggle activity"
-- panel (artifacts/resupply-api/src/routes/admin/feature-flags.ts)
-- previously SELECTed from `resupply.audit_log` with
-- `action='feature_flag.toggle'`. Migration 0156 retired the audit
-- chain, and `logAudit` became a no-op stub — every toggle since
-- then is silently uncounted, and the activity panel renders only
-- legacy rows that grow increasingly stale.
--
-- This table is the dedicated replacement for that one read site.
-- It is INTENTIONALLY NARROW — only the fields the Control Center
-- needs (key, who, when, before/after) — so the migration is
-- low-risk and the writers are trivial. The original audit row
-- carried IP / user-agent / target_table fields that the activity
-- panel never displayed; those are dropped here. The application
-- logger still receives an `event=feature_flag_toggled` line on
-- every toggle for downstream log aggregation.
--
-- Schema notes:
--   * `key` is the flag's stable name (matches feature_flags.key).
--   * `operator_email` is nullable because system toggles (none
--     today, but reserved for future cron-driven kill-switches) carry
--     no operator.
--   * `previous_enabled` / `next_enabled` capture the transition so
--     the panel can render "→" rows without an extra lookup. Both
--     are NOT NULL because a toggle without a state change is
--     filtered out before the insert (see the route handler).
--   * No FK to feature_flags(key) — the activity panel must keep
--     rendering history for flags that were renamed or deleted.

CREATE TABLE IF NOT EXISTS "resupply"."feature_flag_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "previous_enabled" boolean NOT NULL,
  "next_enabled" boolean NOT NULL,
  CONSTRAINT "feature_flag_events_state_change_chk"
    CHECK ("previous_enabled" IS DISTINCT FROM "next_enabled"),
  "operator_email" text,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Newest-first lookup powers the activity panel's default view.
CREATE INDEX IF NOT EXISTS "feature_flag_events_occurred_at_idx"
  ON "resupply"."feature_flag_events" ("occurred_at" DESC);

-- Per-flag history (clicking a flag name in the panel filters here).
CREATE INDEX IF NOT EXISTS "feature_flag_events_key_occurred_at_idx"
  ON "resupply"."feature_flag_events" ("key", "occurred_at" DESC);
