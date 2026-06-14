-- 0330 — therapy_clinical_metrics RPC.
--
-- Powers the supporting-metrics columns on the Clinical Insights report
-- (/admin/therapy-fleet/clinical-insights). The report lists the active
-- clinical smart-trigger signals across the panel; this RPC attaches, in
-- ONE round trip, the recent therapy numbers that let an RT triage each
-- signal from the queue without opening every patient:
--
--   * avg AHI / leak / P95 pressure / usage over a recent window, and
--   * the device's configured MAX pressure (from the latest vendor
--     snapshot) so `pressure_at_max` can be read as "P95 19.8 of max 20".
--
-- Batched by patient-id array so the route resolves the whole (already
-- display-limited) entry set at once. Mirrors the aggregation posture of
-- therapy_fleet_overview / _worklist (averages over a day window, numeric
-- ROUNDed) — admin-gated numbers, never logged.
--
-- Journal posture (per CLAUDE.md): NOT added to meta/_journal.json;
-- migrate.mjs dedups by file hash and runs each SQL once. The route
-- tolerates a missing function (PostgREST returns a clean error the
-- handler catches) so it can deploy before this migration applies.
--
-- Per ADR 003 — versioned hand-authored migration.

-- Ensure the `service_role` role exists before the GRANT (vanilla
-- Postgres in CI from-scratch replays has no such role).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.therapy_clinical_metrics(
  p_patient_ids uuid[],
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
  LEFT JOIN resupply.patient_therapy_nights n
    ON n.patient_id = ids.patient_id
   AND n.night_date >= current_date - p_window_days
  LEFT JOIN LATERAL (
    -- Latest snapshot that actually carries a numeric max pressure. The
    -- regex guards the ::numeric cast against malformed vendor payloads.
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

GRANT EXECUTE ON FUNCTION resupply.therapy_clinical_metrics(uuid[], int)
  TO service_role;
