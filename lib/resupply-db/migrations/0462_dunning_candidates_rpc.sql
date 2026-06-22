-- 0462_dunning_candidates_rpc — set-based candidate finder for the dunning
-- open-scan (perf for migration 0461's engine).
--
-- Why
-- ---
-- The dunning open-scan computed each patient's balance with a per-patient
-- round-trip (claims sum, payments sum) plus three guard lookups (existing run,
-- active plan, autopay). At any real AR volume that is O(patients) PostgREST
-- calls per tick. This function folds the whole candidate selection into ONE
-- set-based query: net open balance ≥ the floor, AND no non-terminal dunning
-- run, AND not on a payment plan / autopay. The open-scan then just opens a run
-- per returned row.
--
-- Open AR = SUM(insurance_claims.patient_responsibility_cents) on BILLABLE
-- (adjudicated) claims. That column is already net of applied payments — the
-- apply_patient_payment RPC (migration 0214) decrements it on every succeeded
-- payment — so we do NOT subtract patient_payments again (double-count), and
-- we restrict to the same billable statuses the statement path uses so
-- provisional draft/submitted/accepted responsibility never opens a run.
--
-- Tenant-scoped by the p_org_id argument (the function is reached through the
-- org-scoped client's .raw().schema("resupply").rpc(...), which does not add
-- the per-tenant filter, so the function filters itself). STABLE + read-only.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE OR REPLACE FUNCTION resupply.dunning_candidates(
  p_org_id uuid,
  p_min_cents integer
)
RETURNS TABLE (patient_id uuid, balance_cents bigint)
LANGUAGE sql
STABLE
AS $$
  WITH owed AS (
    SELECT c.patient_id, SUM(c.patient_responsibility_cents) AS owed_cents
    FROM resupply.insurance_claims c
    WHERE c.org_id = p_org_id
      AND c.patient_responsibility_cents > 0
      AND c.status IN (
        'partially_paid', 'paid', 'denied', 'appealed', 'closed'
      )
    GROUP BY c.patient_id
  )
  SELECT
    o.patient_id,
    o.owed_cents::bigint AS balance_cents
  FROM owed o
  WHERE o.owed_cents >= p_min_cents
    -- No non-terminal dunning run already.
    AND NOT EXISTS (
      SELECT 1 FROM resupply.patient_dunning_runs r
      WHERE r.patient_id = o.patient_id
        AND r.status IN ('active', 'paused')
    )
    -- Not on an active payment plan.
    AND NOT EXISTS (
      SELECT 1 FROM resupply.patient_payment_plans pp
      WHERE pp.patient_id = o.patient_id
        AND pp.status = 'active'
    )
    -- Not enrolled in autopay.
    AND NOT EXISTS (
      SELECT 1 FROM resupply.patient_autopay_authorizations aa
      WHERE aa.patient_id = o.patient_id
        AND aa.autopay_enabled = true
    )
  ORDER BY balance_cents DESC;
$$;
