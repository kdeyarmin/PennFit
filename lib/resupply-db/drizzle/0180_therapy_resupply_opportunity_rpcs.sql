-- 0180 — server-side aggregation RPCs for the Resupply Opportunities
-- view (Therapy Fleet phase 2).
--
-- Background: the therapy-cloud snapshots the nightly sync caches in
-- `resupply.patient_integration_snapshots.payload` carry a vendor
-- `supplies[]` roster — per item: category, description, last-replaced
-- date, and a `nextEligibleDate` (when the patient's plan next allows a
-- replacement). That is a direct line into the DME's core resupply
-- revenue: an item whose nextEligibleDate has arrived is an order
-- waiting to be placed. Until now nothing read it at fleet scale — it
-- was only visible one patient at a time on the Device Data tab.
--
-- These two functions expand the jsonb `supplies` array across every
-- patient and surface the items that are eligible now (or due within a
-- caller-supplied horizon), cross-referenced with the patient's recent
-- mask-leak signal so a failing seal (high leak) on a patient whose
-- mask/cushion is also due floats to the top as a combined re-fit +
-- resupply opportunity.
--
-- jsonb expansion + the date/aggregate predicates have no PostgREST
-- equivalent, so — like 0164 / 0179 — the work is pushed into Postgres
-- and the route receives only the small result set. Both are STABLE
-- SECURITY DEFINER with a pinned search_path and GRANT EXECUTE to
-- service_role only.
--
-- Payload casing: `payload` is the validated IntegrationSnapshot stored
-- verbatim, so keys are camelCase (`supplies`, `nextEligibleDate`,
-- `lastReplacedDate`, `category`, `description`). The high-leak
-- threshold (>= 24 L/min) matches migration 0179 and the UI.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── resupply summary ───────────────────────────────────────────────
-- Single-row rollup of the due/overdue supply roster within
-- `p_due_within_days` of today (0 = eligible now or overdue). Category
-- tallies feed the KPI tiles; `high_leak_refit` counts distinct
-- patients whose mask interface is due AND whose recent leak is high.
CREATE OR REPLACE FUNCTION resupply.therapy_resupply_summary(
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

GRANT EXECUTE ON FUNCTION resupply.therapy_resupply_summary(int) TO service_role;
--> statement-breakpoint

-- ── resupply opportunities list ────────────────────────────────────
-- One row per due/overdue supply item. High-leak mask-interface items
-- sort first (combined re-fit + resupply), then most-overdue first.
CREATE OR REPLACE FUNCTION resupply.therapy_resupply_opportunities(
  p_due_within_days int DEFAULT 0,
  p_limit int DEFAULT 500
)
RETURNS TABLE(
  patient_id uuid,
  source text,
  category text,
  description text,
  last_replaced_date date,
  next_eligible_date date,
  days_until_eligible int,
  high_leak boolean,
  fetched_at timestamptz
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
    GROUP BY patient_id
  ),
  items AS (
    SELECT
      s.patient_id,
      s.source,
      s.fetched_at,
      (elem->>'category') AS category,
      (elem->>'description') AS description,
      NULLIF(elem->>'lastReplacedDate', '')::date AS last_replaced_date,
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
  )
  SELECT
    i.patient_id,
    i.source,
    i.category,
    i.description,
    i.last_replaced_date,
    i.next_eligible_date,
    (i.next_eligible_date - current_date) AS days_until_eligible,
    COALESCE(l.avg_leak >= 24, false) AS high_leak,
    i.fetched_at
  FROM items i
  LEFT JOIN leak l ON l.patient_id = i.patient_id
  WHERE i.next_eligible_date IS NOT NULL
    AND i.next_eligible_date <= current_date + p_due_within_days
  ORDER BY
    (
      COALESCE(l.avg_leak >= 24, false)
      AND i.category IN ('mask', 'cushion', 'headgear')
    ) DESC,
    i.next_eligible_date ASC
  LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION resupply.therapy_resupply_opportunities(int, int) TO service_role;
