-- patient_therapy_nights — nightly CPAP usage rollup per patient,
-- imported from a therapy-cloud provider (ResMed AirView, Philips
-- Care, etc). Phase E.1 / feature #18.
--
-- One row per (patient, night_date, source). The source column
-- means a patient who switches devices over time can have data
-- from multiple clouds without UNIQUE collisions on the date.
--
-- Why we mirror the data locally rather than calling the cloud API
-- on every render:
--   * Therapy clouds rate-limit aggressively. The "show me my
--     last 30 nights" screen would hammer the partner.
--   * The dispatcher that fires data-driven reorder prompts (Phase
--     E.2) needs to scan trends without a partner round-trip.
--   * Audit / privacy: we log who reads PHI in our own audit
--     stream; cloud-provider read logs are out of band.
--
-- PHI posture: every column on this table is PHI by definition
-- (clinical data tied to identity). Reads are admin-gated;
-- customer-facing reads come on a separate endpoint that filters
-- to the calling patient's rows.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_therapy_nights" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- Calendar date the night belongs to (the patient's local TZ as
  -- recorded by the device). We store as `date` not timestamptz so
  -- "the night of May 4" is a clean lookup regardless of the
  -- patient's actual sleep start time.
  "night_date" date NOT NULL,
  "source" text NOT NULL,
  -- Provider-side event id; lets us upsert idempotently when the
  -- partner re-emits the same night.
  "source_event_id" text,
  -- Total mask-on minutes for the night (NULL when the device
  -- didn't report usage — gap in data, not zero).
  "usage_minutes" integer,
  -- Apnea-Hypopnea Index. Stored as numeric to preserve the
  -- decimals partners send. NULL = not reported.
  "ahi" numeric(5, 2),
  -- 95th-percentile leak in L/min. NULL = not reported.
  "leak_rate_l_min" numeric(5, 2),
  -- Optional pressure stats — useful for the trigger "leak trended
  -- up" rule (Phase E.2). NULL when not reported.
  "pressure_p95_cmh2o" numeric(4, 2),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- One row per (patient, night, source). Different sources for the
  -- same night are intentionally allowed (rare, but possible during
  -- a device migration).
  CONSTRAINT "patient_therapy_nights_unique"
    UNIQUE ("patient_id", "night_date", "source"),
  CONSTRAINT "patient_therapy_nights_source_enum"
    CHECK ("source" IN ('resmed_airview', 'philips_care', 'manual'))
);

-- Reverse-chronological per-patient scan: drives the dashboard
-- "last 30 nights" sparkline + the trigger evaluator's window.
CREATE INDEX IF NOT EXISTS "patient_therapy_nights_patient_date_idx"
  ON "resupply"."patient_therapy_nights" ("patient_id", "night_date" DESC);
