-- patient_smart_trigger_events — data-driven reorder nudges derived
-- from patient_therapy_nights (Phase E.2 / feature #19).
--
-- One row per detected trigger event. The evaluator inserts here
-- when a rule fires; the dispatcher reads here to email the
-- patient. Events are NOT auto-dismissed — a CSR can manually
-- mark dismissed (false positive, customer asked us to stop).
--
-- Why a separate table from patient_therapy_nights:
--   * Triggers have lifecycle state (detected → sent → dismissed)
--     that nightly rows don't.
--   * The audit trail of "we nudged patient X for reason Y on
--     date Z" should survive a re-import that overwrites the
--     night data.
--
-- Trigger kinds (start small; add as the rule library grows):
--   * leak_rising      — 14-day rolling leak rate trend ↑
--   * usage_dropping   — 14-day usage minutes trend ↓
--   * cushion_wear     — combined high leak + age-of-cushion proxy
--   * humidifier_drop  — pressure_p95 stable but humidifier
--                        usage minutes dropped (summer pattern)
--
-- Audit verbs:
--   patient.smart_trigger.detected — evaluator inserted
--   patient.smart_trigger.sent     — dispatcher emailed
--   patient.smart_trigger.dismissed — CSR manually cleared
--
-- All envelopes are structural (patient_id + kind + detection
-- window) — the evidence values themselves (leak rate, AHI) are
-- PHI and never logged.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_smart_trigger_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "detected_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- The therapy-night window the rule evaluated. Useful for the
  -- "we noticed your last 14 nights of leak rate" copy in the
  -- email body without re-querying.
  "window_start_date" date NOT NULL,
  "window_end_date" date NOT NULL,
  "sent_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  "dismissed_by_email" text,
  "dismissed_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "patient_smart_trigger_events_kind_enum"
    CHECK ("kind" IN ('leak_rising','usage_dropping','cushion_wear','humidifier_drop'))
);

-- Dispatcher scan: rows pending send (not yet sent + not dismissed),
-- newest detection first.
CREATE INDEX IF NOT EXISTS "patient_smart_trigger_events_pending_idx"
  ON "resupply"."patient_smart_trigger_events" ("detected_at" DESC)
  WHERE "sent_at" IS NULL AND "dismissed_at" IS NULL;

-- Avoid re-inserting the same active trigger (the evaluator
-- shouldn't re-fire while one is still pending OR was sent
-- recently). Partial unique enforces "at most one ACTIVE event
-- per (patient, kind)".
CREATE UNIQUE INDEX IF NOT EXISTS "patient_smart_trigger_events_active_unique"
  ON "resupply"."patient_smart_trigger_events" ("patient_id", "kind")
  WHERE "dismissed_at" IS NULL;

-- Per-patient history index drives the "what triggered before"
-- view on patient detail.
CREATE INDEX IF NOT EXISTS "patient_smart_trigger_events_patient_idx"
  ON "resupply"."patient_smart_trigger_events" ("patient_id", "detected_at" DESC);
