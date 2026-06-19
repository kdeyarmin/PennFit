-- 0323_fulfillments_to_bill_rpc — server-side count of fulfillments
-- that have not yet been billed (no insurance claim exists for them).
--
-- Replaces the two-step client pattern in billing-director.ts that
-- fetched up to 2000 fulfillment UUIDs and then sent them back in a
-- single `.in("fulfillment_id", ids)` PostgREST filter, which can
-- exceed URL length limits (~8 KB) and cause intermittent 414/400
-- failures. This RPC does the anti-join entirely in Postgres.
--
-- Follows the established RPC conventions (0182/0253/0254): SECURITY
-- DEFINER, pinned search_path, STABLE, GRANT EXECUTE to service_role
-- only.

-- service_role guard — vanilla Postgres (CI replay / from-scratch) has
-- no such role; create it idempotently (mirrors 0182/0253).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Count fulfillments shipped on or after p_since that have no
-- insurance claim of any status. Returns bigint (PostgREST serialises
-- it as a string; callers must coerce with Number()).
CREATE OR REPLACE FUNCTION resupply.fulfillments_to_bill_count(
  p_since timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
  SELECT COUNT(*)
  FROM resupply.fulfillments f
  WHERE f.shipped_at >= p_since
    AND NOT EXISTS (
      SELECT 1
      FROM resupply.insurance_claims c
      WHERE c.fulfillment_id = f.id
    )
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.fulfillments_to_bill_count(timestamptz)
  TO service_role;
