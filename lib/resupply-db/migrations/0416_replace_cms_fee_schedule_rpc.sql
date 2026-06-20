-- 0416_replace_cms_fee_schedule_rpc — make the CMS fee-schedule import atomic.
--
-- POST /admin/payer-fee-schedules/import-cms (routes/admin/cms-fee-schedule-
-- import.ts) replaced a quarter's CMS-published fees with a DELETE followed
-- by chunked INSERTs in SEPARATE PostgREST calls, with no transaction. If a
-- later chunk failed (or the process was interrupted) the payer/effective-
-- date schedule was left deleted or partially re-imported — and those rows
-- drive claim pricing, so a partial replace would mis-price claims.
--
-- This function does the whole replace in ONE transaction (PostgREST runs
-- each request in a transaction, and a RAISE inside the function rolls back
-- every statement), so the import either fully succeeds or leaves the prior
-- COMPLETE schedule untouched. It also takes a per-(payer, quarter) advisory
-- lock so two overlapping uploads of the same schedule serialize instead of
-- interleaving their delete/insert.
--
-- Returns { replaced, accepted } so the route can report how many prior rows
-- were swapped out and how many new rows landed.
--
-- Per ADR 003 — versioned hand-authored migration. Idempotent.

-- service_role guard — vanilla Postgres (CI replay) has no such role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.replace_cms_fee_schedule(
  p_org_id uuid,
  p_payer_profile_id uuid,
  p_effective_from date,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_replaced integer;
  v_accepted integer;
BEGIN
  -- Serialize concurrent imports of the SAME payer + quarter so two
  -- overlapping uploads can't interleave their delete/insert. Released at
  -- COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_payer_profile_id::text || ':' || p_effective_from::text, 0
    )
  );

  -- Drop the prior CMS import for this payer + quarter.
  DELETE FROM resupply.payer_fee_schedules
  WHERE org_id = p_org_id
    AND payer_profile_id = p_payer_profile_id
    AND source = 'cms_published'
    AND effective_from = p_effective_from;
  GET DIAGNOSTICS v_replaced = ROW_COUNT;

  -- Insert the new rows in the same transaction.
  INSERT INTO resupply.payer_fee_schedules (
    org_id, payer_profile_id, hcpcs_code, modifier,
    allowed_cents, effective_from, source, notes
  )
  SELECT
    p_org_id, p_payer_profile_id, r.hcpcs_code, r.modifier,
    r.allowed_cents, p_effective_from, 'cms_published', r.notes
  FROM jsonb_to_recordset(p_rows) AS r(
    hcpcs_code text,
    modifier text,
    allowed_cents bigint,
    notes text
  );
  GET DIAGNOSTICS v_accepted = ROW_COUNT;

  RETURN jsonb_build_object('replaced', v_replaced, 'accepted', v_accepted);
END
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.replace_cms_fee_schedule(
  uuid, uuid, date, jsonb
) TO service_role;
