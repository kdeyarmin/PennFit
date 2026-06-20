-- 0179 — server-side aggregation RPCs for the Therapy Fleet view.
--
-- Background: the per-patient therapy-cloud surfaces (Device Data tab,
-- /admin/patients/:id/therapy-nights) already exist, but a DME has no
-- POPULATION-level read of the telemetry it collects every night in
-- `resupply.patient_therapy_nights`. The two functions below roll that
-- per-night data up across the whole patient base so ops can answer:
--   * "How many patients are on track to meet CMS 90/30 compliance,
--      and how many are slipping?" (reimbursement protection)
--   * "Who needs an outreach call TODAY — high mask leak (re-fit /
--      resupply revenue), high residual AHI (clinical escalation),
--      declining usage (churn), or a device that went silent?"
--
-- PostgREST has no GROUP BY / FILTER-aggregate surface, so without
-- these RPCs the route would stream every night row into Node and
-- reduce in JS — O(table) on every page load. These push the work
-- into Postgres (which has the (patient_id, night_date DESC) index
-- from 0046) and return only the small grouped result set.
--
-- Both follow the established RPC pattern in this tree (see
-- 0164_admin_aggregate_rpcs / 0143_inventory_reconciliation_submit_fn):
-- SECURITY DEFINER + pinned search_path + GRANT EXECUTE to
-- service_role only. STABLE (read-only) so the planner can optimize.
--
-- Thresholds encoded here (kept in lockstep with the route + UI):
--   * CMS compliance      — >= 21 nights of >= 4h (240 min) in a 30-day
--                            window. `meetsCmsCompliance` in the shared
--                            ComplianceSummary uses the same rule.
--   * "at risk"           — 10..20 qualifying nights (recoverable).
--   * "non-compliant"     — < 10 qualifying nights but device reporting.
--   * high residual AHI   — mean AHI >= 5.0 events/hr.
--   * high mask leak      — mean 95th-pct leak >= 24 L/min (ResMed's
--                            "large leak" threshold).
--   * usage decline       — current-window mean usage < 75% of the
--                            prior equal-length window's mean.
--   * device silent       — most recent night older than 7 days.

-- Ensure the `service_role` role exists before the GRANTs below. On
-- Supabase (and production) the platform provisions it; a vanilla
-- Postgres — CI's `postgres:14` service container and local
-- from-scratch replays — has no such role and the GRANT would fail.
-- Create it idempotently (NOLOGIN, no privileges); mirrors 0164 / 0143.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── fleet overview ─────────────────────────────────────────────────
-- Single-row population rollup over the most recent `p_window_days`
-- (default 30). Each patient is bucketed into exactly one adherence
-- cohort (compliant / at_risk / non_compliant / no_recent_data) and
-- counted into the clinical-flag tallies. Population means are the
-- mean of per-patient means so one chatty patient can't dominate.
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_overview(
  p_window_days int DEFAULT 30
)
RETURNS TABLE(
  patients_with_data bigint,
  compliant bigint,
  at_risk bigint,
  non_compliant bigint,
  no_recent_data bigint,
  high_ahi bigint,
  high_leak bigint,
  low_usage bigint,
  avg_usage_minutes numeric,
  avg_ahi numeric,
  avg_leak_l_min numeric,
  total_nights bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH agg AS (
    SELECT
      n.patient_id,
      COUNT(*) FILTER (WHERE n.usage_minutes IS NOT NULL) AS nights_with_data,
      COUNT(*) FILTER (WHERE n.usage_minutes >= 240) AS nights_over_4h,
      AVG(n.usage_minutes) FILTER (WHERE n.usage_minutes IS NOT NULL) AS avg_usage,
      AVG(n.ahi) FILTER (WHERE n.ahi IS NOT NULL) AS avg_ahi,
      AVG(n.leak_rate_l_min) FILTER (WHERE n.leak_rate_l_min IS NOT NULL) AS avg_leak,
      COUNT(*) AS night_rows
    FROM resupply.patient_therapy_nights n
    WHERE n.night_date >= current_date - p_window_days
    GROUP BY n.patient_id
  )
  SELECT
    COUNT(*)::bigint AS patients_with_data,
    COUNT(*) FILTER (WHERE nights_over_4h >= 21)::bigint AS compliant,
    COUNT(*) FILTER (WHERE nights_over_4h BETWEEN 10 AND 20)::bigint AS at_risk,
    COUNT(*) FILTER (WHERE nights_over_4h < 10 AND nights_with_data >= 1)::bigint AS non_compliant,
    COUNT(*) FILTER (WHERE nights_with_data = 0)::bigint AS no_recent_data,
    COUNT(*) FILTER (WHERE avg_ahi >= 5)::bigint AS high_ahi,
    COUNT(*) FILTER (WHERE avg_leak >= 24)::bigint AS high_leak,
    COUNT(*) FILTER (WHERE avg_usage < 240 AND nights_with_data >= 1)::bigint AS low_usage,
    ROUND(AVG(avg_usage), 1) AS avg_usage_minutes,
    ROUND(AVG(avg_ahi), 2) AS avg_ahi,
    ROUND(AVG(avg_leak), 1) AS avg_leak_l_min,
    COALESCE(SUM(night_rows), 0)::bigint AS total_nights
  FROM agg
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_overview(int) TO service_role;
--> statement-breakpoint

-- ── fleet worklist ─────────────────────────────────────────────────
-- Per-patient outreach queue. Scans the last 2*p_window_days so it can
-- compare the current window against the prior equal-length window
-- (usage-decline detection) and still surface patients whose device
-- went silent inside the current window. Only rows with >= 1 reason
-- are returned, ordered by a weighted priority so the most
-- reimbursement-/clinically-urgent patients sort to the top.
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_worklist(
  p_window_days int DEFAULT 30,
  p_limit int DEFAULT 200
)
RETURNS TABLE(
  patient_id uuid,
  nights_with_data bigint,
  nights_over_4h bigint,
  avg_usage_minutes numeric,
  avg_ahi numeric,
  avg_leak_l_min numeric,
  prior_avg_usage_minutes numeric,
  last_night_date date,
  days_since_last_night int,
  reasons text[],
  priority int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH agg AS (
    SELECT
      n.patient_id,
      COUNT(*) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.usage_minutes IS NOT NULL
      ) AS nights_with_data,
      COUNT(*) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.usage_minutes >= 240
      ) AS nights_over_4h,
      AVG(n.usage_minutes) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.usage_minutes IS NOT NULL
      ) AS avg_usage,
      AVG(n.ahi) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.ahi IS NOT NULL
      ) AS avg_ahi,
      AVG(n.leak_rate_l_min) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.leak_rate_l_min IS NOT NULL
      ) AS avg_leak,
      AVG(n.usage_minutes) FILTER (
        WHERE n.night_date < current_date - p_window_days
          AND n.usage_minutes IS NOT NULL
      ) AS prior_avg_usage,
      MAX(n.night_date) AS last_night_date
    FROM resupply.patient_therapy_nights n
    WHERE n.night_date >= current_date - (p_window_days * 2)
    GROUP BY n.patient_id
  ),
  scored AS (
    SELECT
      agg.*,
      (current_date - agg.last_night_date) AS days_since_last,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN agg.nights_with_data >= 1 AND agg.nights_over_4h < 21
             THEN 'compliance_risk' END,
        CASE WHEN agg.last_night_date < current_date - 7
             THEN 'no_recent_data' END,
        CASE WHEN agg.avg_ahi >= 5 THEN 'high_ahi' END,
        CASE WHEN agg.avg_leak >= 24 THEN 'high_leak' END,
        CASE WHEN agg.prior_avg_usage IS NOT NULL
              AND agg.avg_usage IS NOT NULL
              AND agg.avg_usage < agg.prior_avg_usage * 0.75
             THEN 'usage_decline' END
      ], NULL) AS reasons,
      (
        (CASE WHEN agg.nights_with_data >= 1 AND agg.nights_over_4h < 21 THEN 40 ELSE 0 END) +
        (CASE WHEN agg.last_night_date < current_date - 7 THEN 30 ELSE 0 END) +
        (CASE WHEN agg.avg_ahi >= 5 THEN 25 ELSE 0 END) +
        (CASE WHEN agg.avg_leak >= 24 THEN 15 ELSE 0 END) +
        (CASE WHEN agg.prior_avg_usage IS NOT NULL
               AND agg.avg_usage IS NOT NULL
               AND agg.avg_usage < agg.prior_avg_usage * 0.75 THEN 10 ELSE 0 END)
      ) AS priority
    FROM agg
  )
  SELECT
    patient_id,
    nights_with_data::bigint,
    nights_over_4h::bigint,
    ROUND(avg_usage, 1) AS avg_usage_minutes,
    ROUND(avg_ahi, 2) AS avg_ahi,
    ROUND(avg_leak, 1) AS avg_leak_l_min,
    ROUND(prior_avg_usage, 1) AS prior_avg_usage_minutes,
    last_night_date,
    days_since_last AS days_since_last_night,
    reasons,
    priority
  FROM scored
  WHERE cardinality(reasons) >= 1
  ORDER BY priority DESC, last_night_date ASC NULLS LAST
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_worklist(int, int) TO service_role;
