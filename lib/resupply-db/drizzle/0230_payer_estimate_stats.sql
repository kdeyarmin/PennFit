-- 0224_payer_estimate_stats — learn the patient out-of-pocket (OOP)
-- estimate from real claim outcomes (owner #O2).
--
-- Today the public /shop/insurance-estimates route returns a hardcoded
-- conservative range per payer (lib/insurance-estimates/data.ts). This
-- adds the substrate to make that estimate LEARN: a tiny per-slug stats
-- table the public route reads, refreshed periodically by a worker that
-- computes P50/P90 of actual patient OOP from adjudicated claims. The
-- public route never scans claims itself — it reads this 11-row table —
-- and falls back to the static range when a slug has too few samples.
--
-- Two objects:
--   * payer_estimate_stats — one row per storefront payer slug with the
--     learned median (p50) + 90th-percentile (p90) OOP in cents and the
--     sample size behind it. Plain table (no RLS), matching the
--     convention for new resupply tables (see 0179_alert_library); the
--     service-role client is the only reader/writer and it holds no PHI
--     (aggregate dollar ranges per payer family).
--   * payer_oop_samples(p_cutoff) — returns one row per ADJUDICATED claim
--     (status paid/closed, decided since the cutoff) with that claim's
--     patient OOP = sum over its line items of greatest(0, allowed-paid).
--     The worker classifies payer_name -> slug and computes the
--     percentiles in TS; this RPC just does the indexed join + sum so the
--     worker never pulls raw line items. HAVING sum(allowed)>0 drops
--     un-adjudicated claims that would otherwise skew the median to $0.
--
-- Follows the established RPC pattern (0164 / 0222 / 0223).
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."payer_estimate_stats" (
  "slug" text PRIMARY KEY,
  "p50_cents" integer NOT NULL,
  "p90_cents" integer NOT NULL,
  "sample_size" integer NOT NULL,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "payer_estimate_stats_nonneg"
    CHECK ("p50_cents" >= 0 AND "p90_cents" >= 0 AND "sample_size" >= 0)
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.payer_oop_samples(p_cutoff timestamptz)
RETURNS TABLE(payer_name text, oop_cents bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    COALESCE(c.payer_name, 'unknown')::text AS payer_name,
    SUM(GREATEST(0, li.allowed_cents - li.paid_cents))::bigint AS oop_cents
  FROM resupply.insurance_claims c
  JOIN resupply.insurance_claim_line_items li ON li.claim_id = c.id
  WHERE c.status IN ('paid', 'closed')
    AND c.decision_at >= p_cutoff
  GROUP BY c.id, c.payer_name
  HAVING SUM(li.allowed_cents) > 0
$$;

GRANT EXECUTE ON FUNCTION resupply.payer_oop_samples(timestamptz) TO service_role;
