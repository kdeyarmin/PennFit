-- 0120_patient_therapy_milestones — celebration touchpoints for CPAP
-- adherence milestones.
--
-- Why
-- ---
-- patient_therapy_nights ingests nightly usage data from the
-- therapy-cloud adapters (AirView, Philips Care, etc.). The smart-
-- trigger engine uses it to detect REORDER signals. Nothing uses it
-- to detect ENGAGEMENT signals — the 100th night on therapy, the
-- first-year anniversary, the first 30-day window where the patient
-- crosses the Medicare 4-hour/70% threshold.
--
-- Adherence-coaching research is unambiguous on this: celebration
-- messages at exactly these milestones have the highest engagement
-- of any single-shot send a DME supplier can make (>50% open rate
-- vs. <25% for generic resupply nudges) AND they correlate with
-- materially higher long-tail adherence. The cost to add is one
-- table + one worker.
--
-- Idempotency
-- -----------
-- One row per (patient_id, milestone_kind). The unique constraint
-- guarantees we celebrate each milestone exactly once. The
-- evaluator does a "scan therapy nights → diff against existing
-- milestones → insert any new ones → send for any unsent rows"
-- pass each night; a crash between insert and send means the next
-- pass picks the row up and the send fires on the next cycle.
--
-- Milestone kinds (deliberately a small enum — copy-tuned templates
-- per kind beat a generic milestone template by a wide margin):
--
--   '100_nights'             — first 100 nights of recorded therapy
--   '365_nights'             — first-year anniversary
--   'first_adherence_month'  — first rolling 30-night window where
--                              >=70% of nights crossed 4+ hours of
--                              use (Medicare's LCD L33718 standard)
--
-- More kinds (500 nights, 1000 nights, 70%-adherence-quarter) can be
-- added by extending the CHECK without a schema change to the row
-- shape — keep the enum boring.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_therapy_milestones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "milestone_kind" text NOT NULL,
  -- The night (or 30-night-window end date) that closed the
  -- milestone. Date, not timestamp — therapy nights are date-keyed.
  "achieved_on" date NOT NULL,
  -- Computed snapshot at achievement time so the celebration
  -- copy can reference real numbers (e.g. "76% of nights >=4hrs"
  -- for the adherence-month milestone). Treat as opaque jsonb;
  -- shape is milestone-kind-specific.
  "metric_snapshot" jsonb,
  "notified_at" timestamp with time zone,
  -- Channel(s) the celebration was sent over. Today only 'email';
  -- the worker is structured so 'sms' / 'push' / 'email+push' are
  -- mechanical additions.
  "notification_channel" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_therapy_milestones_kind_enum"
    CHECK ("milestone_kind" IN (
      '100_nights',
      '365_nights',
      'first_adherence_month'
    ))
);
--> statement-breakpoint

-- One milestone of each kind per patient. The unique guarantee
-- backstops the worker's idempotency — a buggy worker can't
-- double-celebrate.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_therapy_milestones_unique_kind_idx"
  ON "resupply"."patient_therapy_milestones" ("patient_id", "milestone_kind");
--> statement-breakpoint

-- Hot query for the send dispatcher: rows that have been detected
-- but not yet sent. Partial so it stays tiny.
CREATE INDEX IF NOT EXISTS "patient_therapy_milestones_unsent_idx"
  ON "resupply"."patient_therapy_milestones" ("created_at" DESC)
  WHERE "notified_at" IS NULL;
