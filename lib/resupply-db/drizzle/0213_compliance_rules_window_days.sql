-- 0213_compliance_rules_window_days — per-payer compliance WINDOW.
--
-- Extends the per-payer compliance rules from 0212 (min_minutes +
-- required_nights) with a third tunable: the rolling-window length over
-- which `required_nights` must be met. CMS uses 30 days ("21 of 30");
-- some payers define adherence over a different span.
--
-- Scope: window_days applies to the SETUP-ADHERENCE qualification RPCs
-- (the "best rolling W-day count within the first 90 days" — the CMS
-- 90/30 rule). It does NOT touch therapy_fleet_overview / _worklist:
-- their `p_window_days` is the operator-selected TRAILING VIEW window for
-- fleet monitoring, a different concept from a compliance-rule property.
--
-- Why a correlated count instead of the window frame: PostgreSQL RANGE
-- frame offsets ("RANGE BETWEEN INTERVAL '29 days' PRECEDING") must be
-- constant expressions — they cannot reference a per-row / per-partition
-- column, so a per-payer window length can't be expressed as a frame
-- offset. We replace the frame with a correlated subquery that counts
-- qualifying nights in [night_date - (window_days-1), night_date]. The
-- per-patient setup window holds <= 90 deduped nights, so this is cheap.
-- At the default window_days = 30 it is identical to the old frame
-- (BETWEEN night_date-29 AND night_date == RANGE '29 days' PRECEDING).
--
-- Behavior-preserving: every patient resolves to window_days = 30 until a
-- payer rule sets otherwise, so the setup RPCs return identical results.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── column ─────────────────────────────────────────────────────────
ALTER TABLE "resupply"."compliance_rules"
  ADD COLUMN IF NOT EXISTS "window_days" integer NOT NULL DEFAULT 30;
--> statement-breakpoint

-- Rolling-window length must be sane (7..90 days) and >= required_nights
-- so the rule is actually achievable (you can't need 21 qualifying
-- nights in a 14-day window). Guarded so re-runs don't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'compliance_rules_window_days_chk'
  ) THEN
    ALTER TABLE "resupply"."compliance_rules"
      ADD CONSTRAINT "compliance_rules_window_days_chk"
      CHECK ("window_days" >= 7 AND "window_days" <= 90);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'compliance_rules_nights_within_window_chk'
  ) THEN
    ALTER TABLE "resupply"."compliance_rules"
      ADD CONSTRAINT "compliance_rules_nights_within_window_chk"
      CHECK ("required_nights" <= "window_days");
  END IF;
END
$$;
--> statement-breakpoint

-- ── window resolver ────────────────────────────────────────────────
-- Returns exactly one row: the window_days for the highest-priority
-- active rule matching the payer (same resolution order as
-- resolve_compliance_thresholds, so a patient's window + thresholds come
-- from the SAME rule), or the 30-day CMS default.
CREATE OR REPLACE FUNCTION resupply.resolve_compliance_window(p_payer text)
RETURNS TABLE(window_days int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT COALESCE(r.window_days, 30) AS window_days
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT cr.window_days
    FROM resupply.compliance_rules cr
    WHERE cr.active
      AND (cr.match_insurance_payer IS NULL OR cr.match_insurance_payer = p_payer)
    ORDER BY cr.priority ASC, cr.created_at ASC
    LIMIT 1
  ) r ON true
$$;

GRANT EXECUTE ON FUNCTION resupply.resolve_compliance_window(text) TO service_role;
--> statement-breakpoint

-- ── setup-adherence summary (per-payer window) ─────────────────────
-- Identical signature + return columns to 0212; the fixed 30-day rolling
-- frame becomes a per-payer window via a correlated count.
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
      COALESCE(MAX(rolln), 0)::int AS best_30day
    FROM rolling
    GROUP BY patient_id, first_night
  )
  SELECT
    COUNT(*)::bigint AS patients_in_window,
    COUNT(*) FILTER (WHERE best_30day >= required_nights)::bigint AS qualified,
    COUNT(*) FILTER (
      WHERE best_30day < required_nights
        AND (required_nights - best_30day) <= GREATEST(0, (first_night + 89) - current_date)
    )::bigint AS on_track,
    COUNT(*) FILTER (
      WHERE best_30day < required_nights
        AND (required_nights - best_30day) > GREATEST(0, (first_night + 89) - current_date)
    )::bigint AS at_risk
  FROM agg
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_summary() TO service_role;
--> statement-breakpoint

-- ── setup-adherence list (per-payer window) ────────────────────────
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

GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_list(int) TO service_role;
