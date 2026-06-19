-- 0228_billing_denial_risk_rpc — payer × HCPCS denial-rate aggregation
-- that powers a predictive "elevated denial risk" hint at claim preflight.
--
-- Background: claim preflight (lib/billing/claim-preflight.ts) is a
-- deterministic readiness checklist (missing fields, PA, sleep study,
-- modifiers). It does NOT learn from history. Billers have asked for the
-- thing the market calls predictive denial scoring: "this payer denied
-- 38% of recent E0601 claims — double-check modifiers before you submit."
--
-- This function answers exactly that, scoped to ONE payer and the small
-- set of HCPCS codes on the claim being previewed, so the result set is
-- tiny and the scan is indexed. It deliberately mirrors the semantics of
-- resupply.billing_denial_rate (migration 0164): a claim counts as a
-- "denial" when its terminal status is 'denied' or 'appealed', over the
-- decisioned set ('denied','paid','closed','appealed'), within the
-- caller-supplied trailing window. Counting is per DISTINCT claim so a
-- claim with two lines sharing an HCPCS isn't double-counted.
--
-- Follows the established RPC pattern in this tree (0164): SECURITY
-- DEFINER + pinned search_path + GRANT EXECUTE to service_role only,
-- STABLE (read-only).
--
-- Per ADR 003 — versioned hand-authored migration.

-- Ensure the `service_role` role exists before the GRANT below. Supabase
-- and production provision it; a vanilla Postgres (CI's postgres:14
-- service container, local from-scratch replays) does not, so create it
-- idempotently. Mirrors the guard in 0143 / 0164.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Supporting index for the per-payer, windowed scan below (and for the
-- existing billing_denial_rate / AR reporting that filter on the same
-- columns). Additive + idempotent. Partial on decisioned rows keeps it
-- small — undecided/draft claims never participate in denial-rate math.
CREATE INDEX IF NOT EXISTS "insurance_claims_payer_decision_idx"
  ON "resupply"."insurance_claims" ("payer_profile_id", "decision_at")
  WHERE "status" IN ('denied', 'paid', 'closed', 'appealed');
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.billing_denial_risk(
  p_payer_profile_id uuid,
  p_hcpcs text[],
  p_cutoff timestamptz
)
RETURNS TABLE(hcpcs_code text, decisions bigint, denials bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    li.hcpcs_code::text AS hcpcs_code,
    COUNT(DISTINCT c.id)::bigint AS decisions,
    COUNT(DISTINCT c.id) FILTER (
      WHERE c.status IN ('denied', 'appealed')
    )::bigint AS denials
  FROM resupply.insurance_claims c
  JOIN resupply.insurance_claim_line_items li ON li.claim_id = c.id
  WHERE c.payer_profile_id = p_payer_profile_id
    AND c.decision_at >= p_cutoff
    AND c.status IN ('denied', 'paid', 'closed', 'appealed')
    AND li.hcpcs_code = ANY(p_hcpcs)
  GROUP BY li.hcpcs_code
$$;

GRANT EXECUTE ON FUNCTION resupply.billing_denial_risk(uuid, text[], timestamptz) TO service_role;
