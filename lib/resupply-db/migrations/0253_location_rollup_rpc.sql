-- 0253_location_rollup_rpc — per-branch (location) operational rollup.
--
-- Multi-location (owner #O1) phase 4: now that patients and staff carry
-- a nullable location_id (mig 0235) and the admin console assigns them
-- (phases 1-2), operators want to see how the book of business splits
-- across branches. This read-only aggregate returns one row per branch
-- PLUS one NULL-location_id row for the "unassigned" bucket, so the
-- Locations page can render "N patients · M staff" per branch and an
-- unassigned summary in a single round-trip (vs. an N+1 count fan-out
-- in the route layer).
--
-- Billing identity is unaffected — this is purely operational reporting.
-- Counts only; no PHI (no names, no contact info) crosses the boundary.
--
-- Follows the established RPC conventions (0179/0182/0212): SECURITY
-- DEFINER, pinned search_path, STABLE, GRANT EXECUTE to service_role
-- only.

-- service_role guard — vanilla Postgres (CI replay / from-scratch) has
-- no such role; create it idempotently (mirrors 0179/0182/0212).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Per-location counts. The NULL location_id row (when present) is the
-- unassigned bucket. Patients and staff are counted independently, then
-- a UNION of their location_ids forms the key set (UNION treats NULLs as
-- equal, so the unassigned bucket collapses to one row) and each count
-- LEFT-joins back NULL-safely. This avoids a FULL OUTER JOIN, whose join
-- condition must be merge/hash-joinable in Postgres — LEFT JOIN has no
-- such restriction, so `IS NOT DISTINCT FROM` is safe here. A branch
-- with staff but no patients (or vice versa) still appears. Revoked
-- staff are excluded; patient status drives the active sub-count.
CREATE OR REPLACE FUNCTION resupply.location_rollup()
RETURNS TABLE(
  location_id uuid,
  patient_count bigint,
  active_patient_count bigint,
  staff_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  WITH p AS (
    SELECT
      location_id,
      COUNT(*) AS patient_count,
      COUNT(*) FILTER (WHERE status = 'active') AS active_patient_count
    FROM resupply.patients
    GROUP BY location_id
  ),
  s AS (
    SELECT location_id, COUNT(*) AS staff_count
    FROM resupply.admin_users
    WHERE status <> 'revoked'
    GROUP BY location_id
  ),
  keys AS (
    SELECT location_id FROM p
    UNION
    SELECT location_id FROM s
  )
  SELECT
    k.location_id,
    COALESCE(p.patient_count, 0)::bigint AS patient_count,
    COALESCE(p.active_patient_count, 0)::bigint AS active_patient_count,
    COALESCE(s.staff_count, 0)::bigint AS staff_count
  FROM keys k
  LEFT JOIN p ON p.location_id IS NOT DISTINCT FROM k.location_id
  LEFT JOIN s ON s.location_id IS NOT DISTINCT FROM k.location_id
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.location_rollup() TO service_role;
