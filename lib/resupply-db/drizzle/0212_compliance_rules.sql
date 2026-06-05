-- 0212_compliance_rules — per-payer CPAP adherence thresholds.
--
-- Background
-- ---------
-- The therapy-fleet and setup-adherence RPCs (0179, 0182) hard-code the
-- Medicare CMS adherence rule: usage of >= 4 hours (240 min) on >= 21
-- nights (in a 30-day window). That rule is the de-facto standard most
-- payers adopt, but not universally — some Medicaid programs and
-- commercial plans define adherence differently. Hard-coding 240/21
-- mis-classifies those patients, which undermines "identify
-- non-compliance sooner" for every non-Medicare book of business.
--
-- This migration makes the two thresholds configurable per insurance
-- payer, mirroring the proven `frequency_rules` pattern (per-payer,
-- priority-ordered, with a guaranteed default). A patient's thresholds
-- are resolved from their `patients.insurance_payer` against the
-- highest-priority active rule; the seeded default (NULL payer, low
-- precedence, 240/21) makes this change EXACTLY behavior-preserving
-- until an operator adds a payer-specific rule.
--
-- Scope: parameterizes `min_minutes` (was 240) and `required_nights`
-- (was 21). The 30-day rolling window and 90-day setup window stay
-- fixed; a per-payer window is a future extension (a `window_days`
-- column can be added without changing the resolver contract).
--
-- The four RPCs below are CREATE OR REPLACE'd with IDENTICAL signatures
-- and return columns, so the existing routes and SPA need no changes.
-- Follows the established RPC conventions (0179/0182): SECURITY DEFINER,
-- pinned search_path, GRANT EXECUTE to service_role only, STABLE.

-- service_role guard — vanilla Postgres (CI replay / from-scratch) has
-- no such role; create it idempotently (mirrors 0179/0182).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- ── table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resupply"."compliance_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "priority" integer DEFAULT 100 NOT NULL,
  -- NULL = applies to any payer (a catch-all / default rule).
  "match_insurance_payer" text,
  -- Minimum nightly mask-on minutes that counts as a "qualifying"
  -- night. 240 = the CMS 4-hour rule.
  "min_minutes" integer DEFAULT 240 NOT NULL,
  -- Qualifying nights required within the window to be "compliant".
  -- 21 = the CMS 21-of-30 rule.
  "required_nights" integer DEFAULT 21 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "compliance_rules_min_minutes_chk"
    CHECK ("min_minutes" >= 0 AND "min_minutes" <= 1440),
  CONSTRAINT "compliance_rules_required_nights_chk"
    CHECK ("required_nights" >= 1 AND "required_nights" <= 30)
);
--> statement-breakpoint

-- Resolution order index: active rules, lowest priority number first,
-- oldest-created as the tie-break (matches resolve_compliance_thresholds
-- and the frequency_rules convention).
CREATE INDEX IF NOT EXISTS "compliance_rules_active_priority_idx"
  ON "resupply"."compliance_rules" ("active", "priority", "created_at");
--> statement-breakpoint

-- Shared BEFORE UPDATE trigger (resupply.set_updated_at() from 0054).
CREATE TRIGGER "trg_compliance_rules_set_updated_at"
  BEFORE UPDATE ON "resupply"."compliance_rules"
  FOR EACH ROW EXECUTE FUNCTION resupply.set_updated_at();
--> statement-breakpoint

-- RLS deny-all (service_role bypasses) — matches the 0184 posture for
-- admin-only config tables. No anon/authenticated policy is created.
ALTER TABLE "resupply"."compliance_rules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Seed the default rule (NULL payer, low precedence). Guarded so a
-- re-run never inserts a second default. Keeping behavior identical to
-- pre-migration: every patient resolves to 240/21 until a payer rule
-- is added.
INSERT INTO "resupply"."compliance_rules"
  ("name", "priority", "match_insurance_payer", "min_minutes", "required_nights", "active", "notes")
SELECT
  'CMS default (Medicare 4h / 21-of-30)',
  1000,
  NULL,
  240,
  21,
  true,
  'Default CPAP adherence threshold applied when no payer-specific rule matches: >= 4 hours (240 min) on >= 21 nights in the window. Mirrors the Medicare 90/30 standard most payers adopt. Low precedence (priority 1000) so any payer-specific rule wins.'
WHERE NOT EXISTS (
  SELECT 1 FROM "resupply"."compliance_rules" WHERE "match_insurance_payer" IS NULL
);
--> statement-breakpoint

-- ── resolver ───────────────────────────────────────────────────────
-- Returns exactly one row: the (min_minutes, required_nights) for the
-- highest-priority active rule matching the payer, or the 240/21 CMS
-- default when no rule matches (or the table is empty). NULL-payer
-- rules match any patient. A payer-specific rule (lower priority
-- number) wins over the default.
CREATE OR REPLACE FUNCTION resupply.resolve_compliance_thresholds(p_payer text)
RETURNS TABLE(min_minutes int, required_nights int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COALESCE(r.min_minutes, 240)    AS min_minutes,
    COALESCE(r.required_nights, 21) AS required_nights
  FROM (SELECT 1) AS one
  LEFT JOIN LATERAL (
    SELECT cr.min_minutes, cr.required_nights
    FROM resupply.compliance_rules cr
    WHERE cr.active
      AND (cr.match_insurance_payer IS NULL OR cr.match_insurance_payer = p_payer)
    ORDER BY cr.priority ASC, cr.created_at ASC
    LIMIT 1
  ) r ON true
$$;

GRANT EXECUTE ON FUNCTION resupply.resolve_compliance_thresholds(text) TO service_role;
--> statement-breakpoint

-- ── fleet overview (per-payer thresholds) ──────────────────────────
-- Identical signature + return columns to 0179; the 240/21 literals are
-- replaced by each patient's resolved thresholds. Let
-- lo = GREATEST(1, floor(required_nights / 2)). Over patients with >= 1
-- night of data the cohorts are:
--   compliant      nights_over_thr >= required_nights
--   at_risk        lo <= nights_over_thr < required_nights
--   non_compliant  nights_over_thr < lo
--   no_recent_data nights_with_data = 0  (disjoint — these have no data)
-- The lower bound is clamped to >= 1 and both data-bearing buckets carry
-- a nights_with_data >= 1 guard, so the four cohorts stay mutually
-- exclusive and complete even at a small required_nights (e.g. 1, where
-- floor()=0 would otherwise pull no-data patients into at_risk and leave
-- non_compliant unreachable). For the default (required_nights=21) this
-- reproduces the prior fixed bands exactly (>=21 / 10..20 / <10).
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_overview(
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

GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_overview(int) TO service_role;
--> statement-breakpoint

-- ── fleet worklist (per-payer thresholds) ──────────────────────────
-- Identical signature + return columns to 0179. The compliance_risk
-- reason + its 40-pt weight now compare against the patient's
-- required_nights instead of a literal 21. The return column is still
-- named `nights_over_4h` (signature stability) though it now counts
-- nights over the patient's resolved min_minutes.
CREATE OR REPLACE FUNCTION resupply.therapy_fleet_worklist(
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

GRANT EXECUTE ON FUNCTION resupply.therapy_fleet_worklist(int, int) TO service_role;
--> statement-breakpoint

-- ── setup-adherence summary (per-payer thresholds) ─────────────────
-- Identical signature + return columns to 0182; 240 → per-patient
-- min_minutes, 21 → per-patient required_nights.
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
      thr.min_minutes, thr.required_nights
    FROM nights n
    JOIN firsts f USING (patient_id)
    LEFT JOIN resupply.patients p ON p.id = n.patient_id
    CROSS JOIN LATERAL resupply.resolve_compliance_thresholds(p.insurance_payer) thr
    WHERE f.first_night >= current_date - 89
      AND n.night_date <= f.first_night + 89
  ),
  rolling AS (
    SELECT
      patient_id,
      first_night,
      required_nights,
      COUNT(*) FILTER (WHERE usage_minutes >= min_minutes) OVER (
        PARTITION BY patient_id ORDER BY night_date
        RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW
      ) AS roll30
    FROM inwindow
  ),
  agg AS (
    SELECT
      patient_id,
      first_night,
      MAX(required_nights) AS required_nights,
      COALESCE(MAX(roll30), 0)::int AS best_30day
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

-- ── setup-adherence list (per-payer thresholds) ────────────────────
-- Identical signature + return columns to 0182; 240 → per-patient
-- min_minutes, 21 → per-patient required_nights.
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
      thr.min_minutes, thr.required_nights
    FROM nights n
    JOIN firsts f USING (patient_id)
    LEFT JOIN resupply.patients p ON p.id = n.patient_id
    CROSS JOIN LATERAL resupply.resolve_compliance_thresholds(p.insurance_payer) thr
    WHERE f.first_night >= current_date - 89
      AND n.night_date <= f.first_night + 89
  ),
  rolling AS (
    SELECT
      patient_id,
      first_night,
      usage_minutes,
      min_minutes,
      required_nights,
      COUNT(*) FILTER (WHERE usage_minutes >= min_minutes) OVER (
        PARTITION BY patient_id ORDER BY night_date
        RANGE BETWEEN INTERVAL '29 days' PRECEDING AND CURRENT ROW
      ) AS roll30
    FROM inwindow
  ),
  agg AS (
    SELECT
      patient_id,
      first_night,
      MAX(required_nights) AS required_nights,
      COUNT(*) FILTER (WHERE usage_minutes IS NOT NULL) AS nights_in_window,
      COUNT(*) FILTER (WHERE usage_minutes >= min_minutes) AS nights_over_4h,
      COALESCE(MAX(roll30), 0)::int AS best_30day
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
