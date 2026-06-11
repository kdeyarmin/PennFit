-- 0296_restore_therapy_fleet_rpcs — re-assert the 0212 (compliance-
-- aware) bodies of therapy_fleet_overview / therapy_fleet_worklist.
--
-- Why: resolving the duplicate-prefix collisions renamed
-- 0179_therapy_fleet_analytics_rpcs to 0283_therapy_fleet_analytics_rpcs,
-- which moved it AFTER 0212_compliance_rules in fresh-replay order. Both
-- files CREATE OR REPLACE the same two functions (same signatures, same
-- return shape), so on a from-scratch database the 0283 (old, hardcoded
-- 240-min / 21-night) bodies silently overwrite the 0212 (per-payer
-- resolve_compliance_thresholds) bodies. Production applied them in the
-- original order and already has the 0212 bodies; re-running this there
-- is an idempotent no-op.
--
-- The function text below is copied VERBATIM from 0212_compliance_rules.sql.
-- Per ADR 003 — corrective migration, never an in-place edit.

-- Ensure the `service_role` role exists before the GRANTs below (vanilla
-- Postgres in CI from-scratch replays has no such role).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

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
      thr.min_minutes,
      thr.required_nights,
      COUNT(*) FILTER (WHERE n.usage_minutes IS NOT NULL) AS nights_with_data,
      COUNT(*) FILTER (WHERE n.usage_minutes >= thr.min_minutes) AS nights_over_thr,
      AVG(n.usage_minutes) FILTER (WHERE n.usage_minutes IS NOT NULL) AS avg_usage,
      AVG(n.ahi) FILTER (WHERE n.ahi IS NOT NULL) AS avg_ahi,
      AVG(n.leak_rate_l_min) FILTER (WHERE n.leak_rate_l_min IS NOT NULL) AS avg_leak,
      COUNT(*) AS night_rows
    FROM resupply.patient_therapy_nights n
    LEFT JOIN resupply.patients p ON p.id = n.patient_id
    CROSS JOIN LATERAL resupply.resolve_compliance_thresholds(p.insurance_payer) thr
    WHERE n.night_date >= current_date - p_window_days
    GROUP BY n.patient_id, thr.min_minutes, thr.required_nights
  )
  SELECT
    COUNT(*)::bigint AS patients_with_data,
    COUNT(*) FILTER (WHERE nights_over_thr >= required_nights)::bigint AS compliant,
    COUNT(*) FILTER (
      WHERE nights_with_data >= 1
        AND nights_over_thr >= GREATEST(1, floor(required_nights / 2.0))
        AND nights_over_thr < required_nights
    )::bigint AS at_risk,
    COUNT(*) FILTER (
      WHERE nights_with_data >= 1
        AND nights_over_thr < GREATEST(1, floor(required_nights / 2.0))
    )::bigint AS non_compliant,
    COUNT(*) FILTER (WHERE nights_with_data = 0)::bigint AS no_recent_data,
    COUNT(*) FILTER (WHERE avg_ahi >= 5)::bigint AS high_ahi,
    COUNT(*) FILTER (WHERE avg_leak >= 24)::bigint AS high_leak,
    COUNT(*) FILTER (WHERE avg_usage < min_minutes AND nights_with_data >= 1)::bigint AS low_usage,
    ROUND(AVG(avg_usage), 1) AS avg_usage_minutes,
    ROUND(AVG(avg_ahi), 2) AS avg_ahi,
    ROUND(AVG(avg_leak), 1) AS avg_leak_l_min,
    COALESCE(SUM(night_rows), 0)::bigint AS total_nights
  FROM agg
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_overview(int) TO service_role;
--> statement-breakpoint

-- ── fleet worklist (per-payer thresholds) ──────────────────────────
-- Identical signature + return columns to 0179. The compliance_risk
-- reason + its 40-pt weight now compare against the patient's
-- required_nights instead of a literal 21. The return column is still
-- named `nights_over_4h` (signature stability) though it now counts
-- nights over the patient's resolved min_minutes.
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
      thr.min_minutes,
      thr.required_nights,
      COUNT(*) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.usage_minutes IS NOT NULL
      ) AS nights_with_data,
      COUNT(*) FILTER (
        WHERE n.night_date >= current_date - p_window_days
          AND n.usage_minutes >= thr.min_minutes
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
    LEFT JOIN resupply.patients p ON p.id = n.patient_id
    CROSS JOIN LATERAL resupply.resolve_compliance_thresholds(p.insurance_payer) thr
    WHERE n.night_date >= current_date - (p_window_days * 2)
    GROUP BY n.patient_id, thr.min_minutes, thr.required_nights
  ),
  scored AS (
    SELECT
      agg.*,
      (current_date - agg.last_night_date) AS days_since_last,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN agg.nights_with_data >= 1 AND agg.nights_over_4h < agg.required_nights
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
        (CASE WHEN agg.nights_with_data >= 1 AND agg.nights_over_4h < agg.required_nights THEN 40 ELSE 0 END) +
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
