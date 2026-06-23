-- 0470_therapy_fleet_worklist_and_anniversary_org_scoped — multi-tenant:
-- scope the two remaining cross-tenant clinical RPCs that 0381's fleet
-- scoping pass missed.
--
-- WHY (same bug class fixed for the summary RPCs in 0381 and for
-- therapy_setup_adherence_list in 0469)
--   0381 added per-tenant scoping to four Therapy Fleet RPCs but left two
--   patient-row-returning RPCs unscoped. Both aggregate
--   resupply.patient_therapy_nights JOIN resupply.patients with NO org_id
--   predicate, so they return rows for EVERY tenant's patients:
--
--   1. therapy_fleet_worklist(p_window_days, p_limit) — last defined in 0311.
--      Called by GET /admin/therapy-fleet/worklist (+ .csv) — an admin of one
--      tenant receives foreign-tenant patient_ids + clinical metrics (usage,
--      AHI, leak, last-night-date, triage reasons). Externally observable
--      cross-tenant PHI leak. Also called by the therapy-fleet-alerts-scan
--      worker.
--   2. patients_with_therapy_anniversary(p_mmdd, p_current_year, p_limit) —
--      last defined in 0232. Called by the lifecycle-touchpoints worker; it
--      over-fetches every tenant's anniversary patients (the org-scoped
--      UPDATE downstream prevents actually emailing foreign patients, but the
--      job still pulls foreign patient emails/ids into memory and over-counts
--      candidates).
--
-- WHAT (mirrors 0381 / 0469)
--   * Add a leading `p_org_id uuid` parameter and an `org_id = p_org_id`
--     predicate on the base patient_therapy_nights scan (and the patients
--     join), so the whole pipeline is tenant-scoped.
--   * DROP the old global signatures so a stale overload can't silently
--     re-aggregate across tenants.
--
-- patient_therapy_nights carries org_id since 0332; patients is tenant-scoped.
-- The runtime cutover (all three callers pass p_org_id) ships in the same PR.
-- Single-tenant (seed) behavior is unchanged.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── therapy_fleet_worklist — per tenant ──
DROP FUNCTION IF EXISTS resupply.therapy_fleet_worklist(int, int);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_worklist(
  p_org_id uuid,
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
      AND n.org_id = p_org_id
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
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_worklist(uuid, int, int) TO service_role;
--> statement-breakpoint

-- ── patients_with_therapy_anniversary — per tenant ──
DROP FUNCTION IF EXISTS resupply.patients_with_therapy_anniversary(text, int, int);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.patients_with_therapy_anniversary(
  p_org_id uuid,
  p_mmdd text,
  p_current_year int,
  p_limit int DEFAULT 1000
)
RETURNS TABLE(
  patient_id uuid,
  email text,
  legal_first_name text,
  first_night_date date,
  sleep_anniversary_year_sent int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH firsts AS (
    SELECT patient_id, MIN(night_date) AS first_night
    FROM resupply.patient_therapy_nights
    WHERE org_id = p_org_id
    GROUP BY patient_id
  )
  SELECT
    p.id AS patient_id,
    p.email::text,
    p.legal_first_name::text,
    f.first_night AS first_night_date,
    p.sleep_anniversary_year_sent
  FROM resupply.patients p
  JOIN firsts f ON f.patient_id = p.id
  WHERE p.org_id = p_org_id
    AND p.email IS NOT NULL
    AND (
      p.sleep_anniversary_year_sent IS NULL
      OR p.sleep_anniversary_year_sent <> p_current_year
    )
    AND to_char(f.first_night, 'MM-DD') = p_mmdd
    AND EXTRACT(YEAR FROM f.first_night) < p_current_year
  ORDER BY p.id
  LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.patients_with_therapy_anniversary(uuid, text, int, int)
  TO service_role;
