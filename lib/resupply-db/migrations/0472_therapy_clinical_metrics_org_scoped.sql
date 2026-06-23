-- Org-scope the therapy_clinical_metrics RPC (defense-in-depth tenant isolation).
--
-- 0330 created therapy_clinical_metrics(p_patient_ids uuid[], p_window_days int)
-- as a SECURITY DEFINER function that returns per-patient therapy numbers (AHI,
-- leak, P95 pressure, usage, device max) for ANY patient id passed in, with no
-- tenant filter. The only caller builds the id list from an org-scoped query,
-- so there is no known live leak — but the RPC itself would happily return
-- another tenant's clinical metrics for a foreign patient id. Add a required
-- p_org_id and constrain the result to patients that belong to that org, so the
-- function is safe regardless of what ids a caller passes.
--
-- The new signature is (uuid[], uuid, int). Drop the old (uuid[], int) overload
-- so PostgREST can't resolve a call to the unscoped version, and so a caller
-- that forgets p_org_id fails loudly instead of silently bypassing the gate.
-- Idempotent: DROP ... IF EXISTS + CREATE OR REPLACE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Remove the unscoped overload (exact 2-arg signature).
DROP FUNCTION IF EXISTS resupply.therapy_clinical_metrics(uuid[], int);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.therapy_clinical_metrics(
  p_patient_ids uuid[],
  p_org_id uuid,
  p_window_days int DEFAULT 14
)
RETURNS TABLE(
  patient_id uuid,
  nights_in_window bigint,
  last_night_date date,
  avg_ahi numeric,
  avg_leak_l_min numeric,
  avg_pressure_p95 numeric,
  avg_usage_minutes numeric,
  device_max_pressure numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    ids.patient_id,
    COUNT(n.*) FILTER (
      WHERE n.usage_minutes IS NOT NULL
         OR n.ahi IS NOT NULL
         OR n.leak_rate_l_min IS NOT NULL
         OR n.pressure_p95_cmh2o IS NOT NULL
    )::bigint AS nights_in_window,
    MAX(n.night_date) AS last_night_date,
    ROUND(AVG(n.ahi) FILTER (WHERE n.ahi IS NOT NULL), 2) AS avg_ahi,
    ROUND(AVG(n.leak_rate_l_min) FILTER (WHERE n.leak_rate_l_min IS NOT NULL), 1)
      AS avg_leak_l_min,
    ROUND(AVG(n.pressure_p95_cmh2o) FILTER (WHERE n.pressure_p95_cmh2o IS NOT NULL), 1)
      AS avg_pressure_p95,
    ROUND(AVG(n.usage_minutes) FILTER (WHERE n.usage_minutes IS NOT NULL), 0)
      AS avg_usage_minutes,
    dm.device_max_pressure
  FROM unnest(p_patient_ids) AS ids(patient_id)
  -- Only patients that belong to the calling tenant survive this join, so a
  -- foreign patient id contributes no row at all.
  JOIN resupply.patients p
    ON p.id = ids.patient_id
   AND p.org_id = p_org_id
  LEFT JOIN resupply.patient_therapy_nights n
    ON n.patient_id = ids.patient_id
   AND n.night_date >= current_date - p_window_days
  LEFT JOIN LATERAL (
    SELECT (s.payload->'settings'->>'pressureMaxCmh2o')::numeric
             AS device_max_pressure
    FROM resupply.patient_integration_snapshots s
    WHERE s.patient_id = ids.patient_id
      AND (s.payload->'settings'->>'pressureMaxCmh2o') ~ '^[0-9]+(\.[0-9]+)?$'
    ORDER BY s.fetched_at DESC
    LIMIT 1
  ) dm ON true
  GROUP BY ids.patient_id, dm.device_max_pressure
$$;
--> statement-breakpoint

-- SECURITY DEFINER + PostgREST-exposed schema: drop the implicit PUBLIC
-- EXECUTE so anon/authenticated can't call this RPC directly; the API invokes
-- it server-side as service_role only.
REVOKE EXECUTE ON FUNCTION resupply.therapy_clinical_metrics(uuid[], uuid, int)
  FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.therapy_clinical_metrics(uuid[], uuid, int)
  TO service_role;
