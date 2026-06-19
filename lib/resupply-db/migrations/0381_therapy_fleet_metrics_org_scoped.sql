-- 0381_therapy_fleet_metrics_org_scoped — multi-tenant: scope the Therapy
-- Fleet daily snapshot + its four aggregation RPCs per tenant.
--
-- WHY (deferred analytics-grain redesign, slice 2 — see
-- docs/multi-tenant-analytics-grain-redesign-plan.md)
--   therapy_fleet_daily_metrics (mig 0183) is a day-grain aggregate keyed on
--   metric_date alone, and the four RPCs it derives from
--   (therapy_fleet_overview / therapy_resupply_summary /
--   therapy_setup_adherence_summary / therapy_clinical_signal_counts)
--   aggregate across EVERY tenant's clinical data. So today the snapshot row
--   and the three admin fleet dashboards (therapy-fleet / therapy-resupply /
--   therapy-compliance) show platform-wide numbers. A tenant admin must see
--   only THEIR fleet. 0342 deferred the table as a grain redesign; this is it.
--
-- WHAT
--   * therapy_fleet_daily_metrics — add org_id (nullable → backfill seed →
--     NOT NULL), re-key PRIMARY KEY (metric_date) -> (org_id, metric_date),
--     and add the org_isolation RLS policy (RLS was already ENABLEd in 0183).
--   * The four RPCs — add a leading `p_org_id uuid` parameter and an
--     `org_id = p_org_id` predicate on each base clinical table they scan
--     (patient_therapy_nights / patient_integration_snapshots /
--     patient_smart_trigger_events — all carry org_id since 0332/0340/0341).
--     The old global signatures are DROPped (a stale global overload would
--     let a caller silently re-aggregate across tenants).
--
-- The runtime cutover (snapshot fans out per tenant and passes p_org_id; the
-- three admin dashboards pass req.orgId; the fleet-alerts scan org-scopes its
-- read) ships in the same PR. Single-tenant (seed) behavior is unchanged.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- ── therapy_fleet_daily_metrics: re-key per tenant ──
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ADD COLUMN IF NOT EXISTS "org_id" uuid
  REFERENCES "resupply"."organizations"("id");
--> statement-breakpoint
UPDATE "resupply"."therapy_fleet_daily_metrics"
SET "org_id" = (SELECT "id" FROM "resupply"."organizations"
                WHERE "slug" = 'penn-home-medical' LIMIT 1)
WHERE "org_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ALTER COLUMN "org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  DROP CONSTRAINT IF EXISTS "therapy_fleet_daily_metrics_pkey";
--> statement-breakpoint
ALTER TABLE "resupply"."therapy_fleet_daily_metrics"
  ADD CONSTRAINT "therapy_fleet_daily_metrics_pkey"
  PRIMARY KEY ("org_id", "metric_date");
--> statement-breakpoint
DROP POLICY IF EXISTS "org_isolation" ON "resupply"."therapy_fleet_daily_metrics";
--> statement-breakpoint
CREATE POLICY "org_isolation" ON "resupply"."therapy_fleet_daily_metrics"
  USING ("org_id" = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK ("org_id" = current_setting('app.current_org_id', true)::uuid);
--> statement-breakpoint

-- ── therapy_fleet_overview — per tenant ──
DROP FUNCTION IF EXISTS resupply.therapy_fleet_overview(int);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_overview(
  p_org_id uuid,
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
      AND n.org_id = p_org_id
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
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_overview(uuid, int) TO service_role;
--> statement-breakpoint

-- ── therapy_resupply_summary — per tenant ──
DROP FUNCTION IF EXISTS resupply.therapy_resupply_summary(int);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_resupply_summary(
  p_org_id uuid,
  p_due_within_days int DEFAULT 0
)
RETURNS TABLE(
  patients_with_due bigint,
  items_due bigint,
  items_overdue bigint,
  masks_due bigint,
  cushions_due bigint,
  tubing_due bigint,
  filters_due bigint,
  high_leak_refit bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH leak AS (
    SELECT
      patient_id,
      AVG(leak_rate_l_min) FILTER (WHERE leak_rate_l_min IS NOT NULL) AS avg_leak
    FROM resupply.patient_therapy_nights
    WHERE night_date >= current_date - 30
      AND org_id = p_org_id
    GROUP BY patient_id
  ),
  items AS (
    SELECT
      s.patient_id,
      (elem->>'category') AS category,
      NULLIF(elem->>'nextEligibleDate', '')::date AS next_eligible_date
    FROM resupply.patient_integration_snapshots s
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(s.payload->'supplies') = 'array'
          THEN s.payload->'supplies'
        ELSE '[]'::jsonb
      END
    ) AS elem
    WHERE s.fetch_status = 'ok'
      AND s.org_id = p_org_id
  ),
  due AS (
    SELECT
      i.patient_id,
      i.category,
      i.next_eligible_date,
      COALESCE(l.avg_leak >= 24, false) AS high_leak
    FROM items i
    LEFT JOIN leak l ON l.patient_id = i.patient_id
    WHERE i.next_eligible_date IS NOT NULL
      AND i.next_eligible_date <= current_date + p_due_within_days
  )
  SELECT
    COUNT(DISTINCT patient_id)::bigint AS patients_with_due,
    COUNT(*)::bigint AS items_due,
    COUNT(*) FILTER (WHERE next_eligible_date < current_date)::bigint AS items_overdue,
    COUNT(*) FILTER (WHERE category = 'mask')::bigint AS masks_due,
    COUNT(*) FILTER (WHERE category = 'cushion')::bigint AS cushions_due,
    COUNT(*) FILTER (WHERE category = 'tubing')::bigint AS tubing_due,
    COUNT(*) FILTER (WHERE category = 'filter')::bigint AS filters_due,
    COUNT(DISTINCT patient_id) FILTER (
      WHERE high_leak AND category IN ('mask', 'cushion', 'headgear')
    )::bigint AS high_leak_refit
  FROM due
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_resupply_summary(uuid, int) TO service_role;
--> statement-breakpoint

-- ── therapy_setup_adherence_summary — per tenant ──
DROP FUNCTION IF EXISTS resupply.therapy_setup_adherence_summary();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_setup_adherence_summary(
  p_org_id uuid
)
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
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_setup_adherence_summary(uuid) TO service_role;
--> statement-breakpoint

-- ── therapy_clinical_signal_counts — per tenant ──
DROP FUNCTION IF EXISTS resupply.therapy_clinical_signal_counts();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resupply.therapy_clinical_signal_counts(
  p_org_id uuid
)
RETURNS TABLE(
  total bigint,
  high bigint,
  medium bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COUNT(*)::bigint AS total,
    COUNT(*) FILTER (
      WHERE kind IN ('pressure_at_max', 'ahi_elevated', 'non_adherent_30d')
    )::bigint AS high,
    COUNT(*) FILTER (
      WHERE kind IN ('ahi_rising', 'usage_erratic')
    )::bigint AS medium
  FROM resupply.patient_smart_trigger_events
  WHERE dismissed_at IS NULL
    AND org_id = p_org_id
    AND kind IN (
      'pressure_at_max',
      'ahi_elevated',
      'non_adherent_30d',
      'ahi_rising',
      'usage_erratic'
    )
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.therapy_clinical_signal_counts(uuid) TO service_role;
