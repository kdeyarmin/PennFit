-- 0182 — server-side RPCs for the 90-day setup-adherence tracker
-- (Therapy Fleet phase 4).
--
-- Medicare's PAP adherence rule: a new patient must demonstrate use of
-- >= 4h/night on >= 21 nights within a consecutive 30-day period during
-- the first 90 days of therapy, or the rental claim is denied. That
-- 90-day window is where a DME's compliance revenue is won or lost, yet
-- nothing here tracked it — the Phase-1 fleet view uses a flat trailing-
-- 30-day count, not the CMS "best rolling 30-day window within 90 days".
--
-- These two functions compute, for every patient still inside their
-- initial 90-day window, the BEST rolling 30-day count of >=4h nights —
-- the exact CMS qualifying metric — and classify each as:
--   qualified  — best 30-day count already >= 21 (claim defensible)
--   on_track   — not yet 21, but still mathematically reachable in the
--                days remaining (nights_needed <= days_remaining)
--   at_risk    — not yet 21 and can no longer reach 21 before day 90
--                (escalate: re-educate, re-fit, or document non-adherence)
--
-- The 90-day window start is approximated by the patient's FIRST therapy
-- night (the earliest mirrored night) — the best proxy available without
-- a separate setup-date field. Nights are de-duplicated per (patient,
-- date) first (a patient can have one night row per source), taking the
-- best usage so a multi-source night isn't double-counted and the RANGE
-- frame has no peer rows.
--
-- The rolling 30-day count uses a date-RANGE window frame
-- (RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW), so each
-- night's value is "qualifying nights in the trailing 30 days"; MAX of
-- that per patient is the best 30-day window. Pushed into Postgres for
-- the same reasons as 0164/0179. STABLE SECURITY DEFINER, pinned
-- search_path, GRANT EXECUTE to service_role only.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── setup-adherence summary ────────────────────────────────────────
-- Single-row rollup of every patient currently inside their 90-day
-- window, bucketed into the three adherence states.
CREATE OR REPLACE FUNCTION resupply.therapy_setup_adherence_summary()
RETURNS TABLE(
  patients_in_window bigint,
  qualified bigint,
  on_track bigint,
  at_risk bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH nights AS (
    SELECT patient_id, night_date, MAX(usage_minutes) AS usage_minutes
    FROM resupply.patient_therapy_nights
    GROUP BY patient_id, night_date
  ),
  firsts AS (
    SELECT patient_id, MIN(night_date) AS first_night
    FROM nights
    GROUP BY patient_id
  ),
  inwindow AS (
    SELECT n.patient_id, n.night_date, n.usage_minutes, f.first_night
    FROM nights n
    JOIN firsts f USING (patient_id)
    WHERE f.first_night >= current_date - 89
      AND n.night_date <= f.first_night + 89
  ),
  rolling AS (
    SELECT
      patient_id,
      first_night,
      COUNT(*) FILTER (WHERE usage_minutes >= 240) OVER (
        PARTITION BY patient_id ORDER BY night_date
        RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW
      ) AS roll30
    FROM inwindow
  ),
  agg AS (
    SELECT patient_id, first_night, COALESCE(MAX(roll30), 0)::int AS best_30day
    FROM rolling
    GROUP BY patient_id, first_night
  )
  SELECT
    COUNT(*)::bigint AS patients_in_window,
    COUNT(*) FILTER (WHERE best_30day >= 21)::bigint AS qualified,
    COUNT(*) FILTER (
      WHERE best_30day < 21
        AND (21 - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
    )::bigint AS on_track,
    COUNT(*) FILTER (
      WHERE best_30day < 21
        AND (21 - best_30day) > GREATEST(0, (first_night + 89) - current_date)
    )::bigint AS at_risk
  FROM agg
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_summary() TO service_role;
--> statement-breakpoint

-- ── setup-adherence list ───────────────────────────────────────────
-- Per-patient detail. at_risk first (most urgent), then fewest days
-- remaining in the window.
CREATE OR REPLACE FUNCTION resupply.therapy_setup_adherence_list(
  p_limit int DEFAULT 200
)
RETURNS TABLE(
  patient_id uuid,
  first_night_date date,
  days_elapsed int,
  days_remaining int,
  nights_in_window bigint,
  nights_over_4h bigint,
  best_30day_count int,
  nights_needed int,
  status text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH nights AS (
    SELECT patient_id, night_date, MAX(usage_minutes) AS usage_minutes
    FROM resupply.patient_therapy_nights
    GROUP BY patient_id, night_date
  ),
  firsts AS (
    SELECT patient_id, MIN(night_date) AS first_night
    FROM nights
    GROUP BY patient_id
  ),
  inwindow AS (
    SELECT n.patient_id, n.night_date, n.usage_minutes, f.first_night
    FROM nights n
    JOIN firsts f USING (patient_id)
    WHERE f.first_night >= current_date - 89
      AND n.night_date <= f.first_night + 89
  ),
  rolling AS (
    SELECT
      patient_id,
      first_night,
      usage_minutes,
      COUNT(*) FILTER (WHERE usage_minutes >= 240) OVER (
        PARTITION BY patient_id ORDER BY night_date
        RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW
      ) AS roll30
    FROM inwindow
  ),
  agg AS (
    SELECT
      patient_id,
      first_night,
      COUNT(*) FILTER (WHERE usage_minutes IS NOT NULL) AS nights_in_window,
      COUNT(*) FILTER (WHERE usage_minutes >= 240) AS nights_over_4h,
      COALESCE(MAX(roll30), 0)::int AS best_30day
    FROM rolling
    GROUP BY patient_id, first_night
  )
  SELECT
    patient_id,
    first_night AS first_night_date,
    (current_date - first_night) AS days_elapsed,
    GREATEST(0, (first_night + 89) - current_date) AS days_remaining,
    nights_in_window,
    nights_over_4h,
    best_30day AS best_30day_count,
    GREATEST(0, 21 - best_30day) AS nights_needed,
    CASE
      WHEN best_30day >= 21 THEN 'qualified'
      WHEN (21 - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
        THEN 'on_track'
      ELSE 'at_risk'
    END AS status
  FROM agg
  ORDER BY
    CASE
      WHEN best_30day >= 21 THEN 2
      WHEN (21 - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
        THEN 1
      ELSE 0
    END ASC,
    ((first_night + 89) - current_date) ASC
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_list(int) TO service_role;
