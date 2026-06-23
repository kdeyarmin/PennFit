-- 0469_therapy_setup_adherence_list_org_scoped — multi-tenant: scope the
-- setup-adherence LIST RPC per tenant (the sibling SUMMARY RPC was already
-- scoped in 0381; the list variant was left behind).
--
-- WHY (cross-tenant PHI leak)
--   resupply.therapy_setup_adherence_list(p_limit int) — last redefined in
--   0213 — aggregates resupply.patient_therapy_nights JOIN resupply.patients
--   with NO org_id predicate, so it returns adherence rows (patient_id,
--   first-night dates, nights-used, CMS adherence status) for EVERY tenant's
--   patients. Its three callers run in a single-tenant context but receive
--   all tenants' rows:
--     * GET /admin/therapy-compliance/setups (+ .csv) — returns the raw RPC
--       rows (foreign patient_ids + adherence metrics) to a signed-in admin
--       of one tenant. This is an externally-observable PHI leak.
--     * worker therapy-setup-deadline-outreach / therapy-fleet-alerts-scan —
--       over-count and process foreign patient_ids in memory (they avoid
--       actually messaging foreign patients only because the downstream
--       send re-fetches the patient through the org-scoped client).
--
--   0381 fixed the exact same class of bug for therapy_setup_adherence_summary
--   (and the other three fleet RPCs) by adding a leading `p_org_id uuid`
--   parameter and an `org_id = p_org_id` predicate on patient_therapy_nights.
--   This applies the identical treatment to the list variant.
--
-- WHAT
--   * Add a leading `p_org_id uuid` parameter; filter the base `nights` CTE
--     (resupply.patient_therapy_nights — carries org_id since 0332) on
--     `org_id = p_org_id`. Everything downstream keys off `nights`, so the
--     whole pipeline is then tenant-scoped.
--   * DROP the old global `(int)` signature so a stale overload can't let a
--     caller silently re-aggregate across tenants.
--
-- The runtime cutover (the three callers pass p_org_id) ships in the same PR.
-- Single-tenant (seed) behavior is unchanged.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

DROP FUNCTION IF EXISTS resupply.therapy_setup_adherence_list(int);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_setup_adherence_list(
  p_org_id uuid,
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
    WHERE org_id = p_org_id
    GROUP BY patient_id, night_date
  ),
  firsts AS (
    SELECT patient_id, MIN(night_date) AS first_night
    FROM nights
    GROUP BY patient_id
  ),
  inwindow AS (
    SELECT
      n.patient_id, n.night_date, n.usage_minutes, f.first_night,
      thr.min_minutes, thr.required_nights, win.window_days
    FROM nights n
    JOIN firsts f USING (patient_id)
    LEFT JOIN resupply.patients p ON p.id = n.patient_id
    CROSS JOIN LATERAL resupply.resolve_compliance_thresholds(p.insurance_payer) thr
    CROSS JOIN LATERAL resupply.resolve_compliance_window(p.insurance_payer) win
    WHERE f.first_night >= current_date - 89
      AND n.night_date <= f.first_night + 89
  ),
  rolling AS (
    SELECT
      iw.patient_id,
      iw.first_night,
      iw.usage_minutes,
      iw.min_minutes,
      iw.required_nights,
      (
        SELECT COUNT(*)
        FROM inwindow iw2
        WHERE iw2.patient_id = iw.patient_id
          AND iw2.night_date
              BETWEEN iw.night_date - (iw.window_days - 1) AND iw.night_date
          AND iw2.usage_minutes >= iw2.min_minutes
      ) AS rolln
    FROM inwindow iw
  ),
  agg AS (
    SELECT
      patient_id,
      first_night,
      MAX(required_nights) AS required_nights,
      COUNT(*) FILTER (WHERE usage_minutes IS NOT NULL) AS nights_in_window,
      COUNT(*) FILTER (WHERE usage_minutes >= min_minutes) AS nights_over_4h,
      COALESCE(MAX(rolln), 0)::int AS best_30day
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
    GREATEST(0, required_nights - best_30day) AS nights_needed,
    CASE
      WHEN best_30day >= required_nights THEN 'qualified'
      WHEN (required_nights - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
        THEN 'on_track'
      ELSE 'at_risk'
    END AS status
  FROM agg
  ORDER BY
    CASE
      WHEN best_30day >= required_nights THEN 2
      WHEN (required_nights - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
        THEN 1
      ELSE 0
    END ASC,
    ((first_night + 89) - current_date) ASC
  LIMIT p_limit
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_list(uuid, int) TO service_role;
