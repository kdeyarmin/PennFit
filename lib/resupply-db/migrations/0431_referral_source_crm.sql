-- 0431_referral_source_crm — referral-source scorecard + rep-activity log.
--
-- The only B2B referral-source signal in the data model is
-- insurance_claims.referring_provider_id -> providers (the claim's
-- referring/ordering physician, captured for 837P loop 2310D). There was no
-- relationship-management layer on top: no view of which referring physicians
-- drive the most claim volume / revenue, and nowhere to log rep touches
-- (visits/calls) against a referring source. This adds both.
--
-- Two objects:
--   * referral_source_activity — an org-scoped rep-touch log keyed to a
--     provider (SOFT FK to resupply.providers; providers is a SHARED NPPES
--     registry with no org_id, so the per-tenant relationship lives here).
--     Org-scoped like every tenant table — the service-role facade
--     (getOrgScopedClient) appends/injects org_id.
--   * referral_source_scorecard(p_org_id, p_since) — per referring-provider
--     rollup over THIS tenant's claims: claim/patient counts, claims in the
--     window, paid revenue, and the last rep-activity date. bigint counts
--     serialize as string over PostgREST. The LEFT JOIN to line items fans
--     claim rows out, so counts use COUNT(DISTINCT) and revenue SUMs all line
--     items (correct under the fan-out).
--
-- Follows the established RPC pattern (0164 / 0228 / 0230). Idempotent (IF NOT
-- EXISTS / CREATE OR REPLACE) so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "resupply"."referral_source_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "provider_id" uuid NOT NULL,
  "activity_type" text NOT NULL DEFAULT 'visit',
  "occurred_on" date NOT NULL DEFAULT current_date,
  "summary" text NOT NULL,
  "next_action" text,
  "created_by_email" text,
  "created_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "referral_source_activity_type_chk"
    CHECK (
      "activity_type" IN ('visit', 'call', 'email', 'lunch', 'mailer', 'other')
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "referral_source_activity_org_provider_idx"
  ON "resupply"."referral_source_activity" (
    "org_id", "provider_id", "occurred_on" DESC
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

CREATE OR REPLACE FUNCTION resupply.referral_source_scorecard(
  p_org_id uuid,
  p_since timestamptz
)
RETURNS TABLE(
  provider_id uuid,
  provider_name text,
  practice_name text,
  npi text,
  claim_count bigint,
  patient_count bigint,
  claims_since bigint,
  paid_cents bigint,
  last_activity_on date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT
    p.id AS provider_id,
    p.legal_name::text AS provider_name,
    p.practice_name::text AS practice_name,
    p.npi::text AS npi,
    COUNT(DISTINCT c.id)::bigint AS claim_count,
    COUNT(DISTINCT c.patient_id)::bigint AS patient_count,
    COUNT(DISTINCT c.id) FILTER (WHERE c.created_at >= p_since)::bigint
      AS claims_since,
    COALESCE(
      SUM(li.paid_cents) FILTER (
        WHERE c.status IN ('paid', 'closed', 'partially_paid')
      ),
      0
    )::bigint AS paid_cents,
    la.last_activity_on
  FROM resupply.insurance_claims c
  JOIN resupply.providers p ON p.id = c.referring_provider_id
  LEFT JOIN resupply.insurance_claim_line_items li ON li.claim_id = c.id
  LEFT JOIN LATERAL (
    SELECT MAX(act.occurred_on) AS last_activity_on
    FROM resupply.referral_source_activity act
    WHERE act.provider_id = p.id AND act.org_id = p_org_id
  ) la ON true
  WHERE c.org_id = p_org_id
    AND c.referring_provider_id IS NOT NULL
  GROUP BY p.id, p.legal_name, p.practice_name, p.npi, la.last_activity_on
  ORDER BY claim_count DESC, paid_cents DESC
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.referral_source_scorecard(uuid, timestamptz)
  TO service_role;
