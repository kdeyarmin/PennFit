-- 0232_worker_batch_rpcs — server-side aggregates that let four nightly /
-- weekly worker jobs replace per-candidate N+1 queries with a single
-- bounded round-trip. Follow-up to the 2026-06-05 performance review
-- (§2 Worker/background jobs) and PR #552's "bound unguarded Supabase
-- reads against PostgREST caps" pass.
--
-- Each function pushes a GROUP BY / DISTINCT ON that PostgREST cannot
-- express into Postgres, returning at most one row per group so the
-- result stays well under the ~1000-row response cap. Without these the
-- jobs either issued one query per patient/customer (an N+1 that grows
-- with the roster) or risked a silent truncation when a naive batched
-- `.in()` over-fetched the underlying detail rows.
--
-- Column types are pinned to the live schema: shop_orders/shop_customers
-- `customer_id` is text (not uuid), metrics_daily.metric_value is
-- double precision, and patient_maintenance_log.task_key is varchar(64)
-- (cast to text for the output column). A RETURNS-TABLE type mismatch
-- would fail CREATE FUNCTION at deploy, which gates the release.
--
-- Follows the established RPC pattern (0164 / 0228 / 0229): SECURITY
-- DEFINER + pinned search_path + GRANT EXECUTE to service_role only,
-- STABLE (pure reads). Per ADR 003 — versioned hand-authored migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── lifecycle anniversary matches ──────────────────────────────────
-- For the lifecycle-touchpoints anniversary pass: return only the
-- patients whose FIRST-ever therapy night falls on today's MM-DD (in a
-- prior year) and who haven't been stamped this year. The prior worker
-- read MIN(night_date) once per candidate (up to PER_KIND_MAX * 4 serial
-- round-trips) just to discard the ~99.7% whose anniversary isn't today;
-- this collapses that to one query returning the handful of true matches.
CREATE OR REPLACE FUNCTION resupply.patients_with_therapy_anniversary(
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
  WHERE p.email IS NOT NULL
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

GRANT EXECUTE ON FUNCTION resupply.patients_with_therapy_anniversary(text, int, int)
  TO service_role;
--> statement-breakpoint

-- ── maintenance: latest completion per (patient, task) ─────────────
-- For the weekly maintenance-nudge job: the latest completion timestamp
-- per task for a batch of patients. The prior worker read the patient's
-- ENTIRE maintenance log once per patient (N+1) and folded it to
-- latest-per-task in JS; a naive batched `.in()` would instead pull
-- every log row for every patient (years of history) and risk the
-- 1000-row truncation. DISTINCT ON returns exactly one row per
-- (patient, task) — at most patients × the small fixed task catalog.
CREATE OR REPLACE FUNCTION resupply.patient_maintenance_latest_by_task(
  p_patient_ids uuid[]
)
RETURNS TABLE(
  patient_id uuid,
  task_key text,
  completed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT DISTINCT ON (patient_id, task_key)
    patient_id, task_key::text, completed_at
  FROM resupply.patient_maintenance_log
  WHERE patient_id = ANY(p_patient_ids)
  ORDER BY patient_id, task_key, completed_at DESC
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.patient_maintenance_latest_by_task(uuid[])
  TO service_role;
--> statement-breakpoint

-- ── shop customers: most-recent paid order per customer ────────────
-- For the November deductible-reset push: the MAX(paid_at) of each
-- customer's paid orders, restricted to a candidate batch. The prior
-- worker ran a per-customer existence query (N+1). MAX(paid_at) answers
-- both "has any paid order" and "how recent" in one bounded row per
-- customer, and is exactly the aggregate the lapsed-customer-winback
-- job would need to batch its 3-window classification later.
-- customer_id is text in this schema (not uuid).
CREATE OR REPLACE FUNCTION resupply.shop_customers_last_paid_at(
  p_customer_ids text[]
)
RETURNS TABLE(
  customer_id text,
  last_paid_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT customer_id, MAX(paid_at) AS last_paid_at
  FROM resupply.shop_orders
  WHERE customer_id = ANY(p_customer_ids)
    AND status = 'paid'
    AND paid_at IS NOT NULL
  GROUP BY customer_id
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.shop_customers_last_paid_at(text[])
  TO service_role;
--> statement-breakpoint

-- ── metrics: latest snapshot per metric key ────────────────────────
-- For the daily metric-alerts evaluator: the most-recent metrics_daily
-- row for each enabled threshold's metric_key, in one query instead of
-- one ordered limit-1 read per threshold (N+1). DISTINCT ON returns one
-- row per key; the evaluator fetches any delta-mode baselines in a
-- second bounded `.in()` keyed on the dates this returns. metric_value
-- is double precision in this schema.
CREATE OR REPLACE FUNCTION resupply.metrics_daily_latest(
  p_metric_keys text[]
)
RETURNS TABLE(
  metric_key text,
  metric_date date,
  metric_value double precision,
  unit text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT DISTINCT ON (metric_key)
    metric_key, metric_date, metric_value, unit
  FROM resupply.metrics_daily
  WHERE metric_key = ANY(p_metric_keys)
  ORDER BY metric_key, metric_date DESC
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.metrics_daily_latest(text[]) TO service_role;
