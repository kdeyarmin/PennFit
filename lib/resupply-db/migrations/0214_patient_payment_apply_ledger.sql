-- 0214 — atomic, idempotent application of succeeded patient payments to
-- claim balances.
--
-- Problem (code review D5): markPaymentStatus() flips
-- patient_payments.status to 'succeeded' (an atomic CAS), then SEPARATELY
-- decrements each claim's patient_responsibility_cents in
-- applySucceededPayment(). PostgREST has no multi-statement transaction,
-- so a crash between the status flip and the decrement leaves the balance
-- OVERSTATED forever: on Stripe redelivery the CAS flip is a no-op
-- (already 'succeeded') and the decrement never re-runs. And
-- applySucceededPayment() was not idempotent, so it couldn't simply be
-- re-run (it would double-decrement).
--
-- Fix: a single SECURITY DEFINER function that applies a payment's
-- allocations ATOMICALLY and IDEMPOTENTLY. A per-(payment, claim) ledger
-- row (PRIMARY KEY (payment_id, claim_id)) records each application
-- exactly once; the function only decrements a claim when it successfully
-- claims the ledger slot, so re-running it completes a crash-interrupted
-- apply WITHOUT double-decrementing the slots that already applied.
-- Because the whole function body runs in one implicit transaction, the
-- ledger insert and the decrement commit together or not at all.

-- service_role exists on Supabase/production; create it idempotently so
-- the GRANT below also works on vanilla Postgres (CI replay / local).
-- Mirrors the guard in 0143 / 0164.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resupply"."patient_payment_claim_applications" (
  "payment_id" uuid NOT NULL
    REFERENCES "resupply"."patient_payments"("id") ON DELETE CASCADE,
  "claim_id" uuid NOT NULL
    REFERENCES "resupply"."insurance_claims"("id") ON DELETE CASCADE,
  "amount_cents" integer NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  -- One application row per (payment, claim). This is the idempotency
  -- key the apply function claims with ON CONFLICT DO NOTHING.
  PRIMARY KEY ("payment_id", "claim_id")
);
--> statement-breakpoint

-- Apply every allocation on a succeeded payment, exactly once each.
-- Idempotent: safe to call repeatedly (Stripe redelivery, or a retry
-- after a crash that interrupted a prior apply).
CREATE OR REPLACE FUNCTION resupply.apply_patient_payment(p_payment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_patient_id uuid;
  v_allocations jsonb;
  v_alloc jsonb;
  v_claim_id uuid;
  v_amount integer;
  v_rowcount integer;
BEGIN
  SELECT patient_id, applied_claims_json
    INTO v_patient_id, v_allocations
  FROM resupply.patient_payments
  WHERE id = p_payment_id;

  -- Payment row gone (deleted between webhook ingest and apply).
  IF v_patient_id IS NULL THEN
    RETURN;
  END IF;

  IF v_allocations IS NULL OR jsonb_typeof(v_allocations) <> 'array' THEN
    RETURN;
  END IF;

  FOR v_alloc IN SELECT * FROM jsonb_array_elements(v_allocations)
  LOOP
    v_claim_id := (v_alloc->>'claimId')::uuid;
    v_amount := COALESCE((v_alloc->>'amountAppliedCents')::integer, 0);
    IF v_claim_id IS NULL OR v_amount <= 0 THEN
      CONTINUE;
    END IF;

    -- Claim the per-(payment, claim) ledger slot. ON CONFLICT DO NOTHING
    -- makes the apply idempotent: a slot that already applied inserts no
    -- row, and we skip its decrement below.
    INSERT INTO resupply.patient_payment_claim_applications
      ("payment_id", "claim_id", "amount_cents")
    VALUES (p_payment_id, v_claim_id, v_amount)
    ON CONFLICT ("payment_id", "claim_id") DO NOTHING;

    GET DIAGNOSTICS v_rowcount = ROW_COUNT;
    IF v_rowcount = 0 THEN
      CONTINUE; -- already applied for this (payment, claim)
    END IF;

    -- First application of this (payment, claim): decrement the balance
    -- (clamped at 0) and write the audit event. Same transaction as the
    -- ledger insert above, so a crash can't split them.
    UPDATE resupply.insurance_claims
    SET patient_responsibility_cents =
          GREATEST(0, patient_responsibility_cents - v_amount),
        updated_at = now()
    WHERE id = v_claim_id
      AND patient_id = v_patient_id;

    INSERT INTO resupply.insurance_claim_events
      ("claim_id", "event_type", "amount_cents", "payer_ref", "note", "actor_email")
    VALUES (
      v_claim_id,
      'note',
      v_amount,
      p_payment_id::text,
      'Patient payment applied: ' || v_amount || '¢ via payment ' || p_payment_id::text,
      'system:patient_payment_apply'
    );
  END LOOP;
END;
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.apply_patient_payment(uuid) TO service_role;
