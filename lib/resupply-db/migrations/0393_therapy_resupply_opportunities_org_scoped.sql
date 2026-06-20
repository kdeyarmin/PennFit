-- 0393_therapy_resupply_opportunities_org_scoped — finish the multi-tenant
-- cutover for the resupply RPCs.
--
-- 0381 added a leading `p_org_id uuid` + `org_id = p_org_id` predicate to
-- therapy_fleet_overview / therapy_resupply_summary / setup-adherence /
-- clinical-signal-counts, but MISSED therapy_resupply_opportunities — the
-- per-item list RPC. Left unscoped, it scans patient_integration_snapshots
-- (and patient_therapy_nights for the leak flag) across ALL tenants, so a
-- per-tenant caller (the /admin/therapy-resupply/opportunities route and the
-- new resupply.auto-draft worker) would see — and, for the worker, stage
-- drafts from — other tenants' patients. This closes that gap with the same
-- pattern 0381 used: drop the unscoped signature, recreate with p_org_id and
-- an `org_id = p_org_id` predicate on every base table it scans.
--
-- Both call sites pass `{ p_org_id: orgId, ... }` after this lands.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

DROP FUNCTION IF EXISTS resupply.therapy_resupply_opportunities(int, int);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.therapy_resupply_opportunities(
  p_org_id uuid,
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
      AND org_id = p_org_id
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
      AND s.org_id = p_org_id
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
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.therapy_resupply_opportunities(uuid, int, int) TO service_role;
