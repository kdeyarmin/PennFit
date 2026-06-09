-- 0255_payment_plan_autopay — opt-in Stripe auto-charge for patient
-- payment-plan installments (biller #B7 follow-up / financing).
--
-- Migration 0236 added the installment tracker but deliberately moved no
-- money ("Automatic Stripe charging against the schedule is a deliberate
-- follow-up"). This adds the substrate to charge a scheduled installment
-- off-session — but ONLY against a payment method the patient explicitly
-- authorized for recurring charges.
--
-- Consent model (off-session mandate):
--   * autopay_status starts 'off'. A CSR sends the patient a Stripe
--     Checkout *setup* session (mode=setup) → autopay_status='pending'.
--   * On the patient completing it, the webhook stores the Stripe
--     customer + payment method and the mandate timestamp, flipping
--     autopay_status='authorized'. Stripe's hosted setup page captures
--     the standard off-session mandate consent text.
--   * The auto-charge worker charges due installments ONLY when
--     autopay_status='authorized' AND both stripe ids are present. A
--     patient (or CSR) can revoke → 'revoked' (no further charges).
--
-- Safety: charging is additionally gated by the seeded-OFF feature flag
-- below AND an env cron var on the worker, so nothing charges in dev /
-- preview or until an operator explicitly turns it on.
--
-- Plain columns (no RLS) — service-role client only. Per ADR 003 —
-- versioned hand-authored migration.

ALTER TABLE "resupply"."patient_payment_plans"
  ADD COLUMN IF NOT EXISTS "autopay_status" text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS "stripe_customer_id" text,
  ADD COLUMN IF NOT EXISTS "stripe_payment_method_id" text,
  ADD COLUMN IF NOT EXISTS "autopay_authorized_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "autopay_revoked_at" timestamp with time zone;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patient_payment_plans_autopay_chk'
  ) THEN
    ALTER TABLE "resupply"."patient_payment_plans"
      ADD CONSTRAINT "patient_payment_plans_autopay_chk"
      CHECK ("autopay_status" IN ('off', 'pending', 'authorized', 'revoked'));
  END IF;
END
$$;
--> statement-breakpoint

-- Installment charge-attempt tracking + the new 'action_required'
-- terminal-ish state (card needs 3DS / re-auth) and 'failed' (declined).
ALTER TABLE "resupply"."patient_payment_plan_installments"
  ADD COLUMN IF NOT EXISTS "charge_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_charge_error" text,
  ADD COLUMN IF NOT EXISTS "last_charge_attempt_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "stripe_payment_intent_id" text;
--> statement-breakpoint

-- Widen the installment status check to include the auto-charge states.
DO $$
BEGIN
  ALTER TABLE "resupply"."patient_payment_plan_installments"
    DROP CONSTRAINT IF EXISTS "ppp_installments_status_chk";
  ALTER TABLE "resupply"."patient_payment_plan_installments"
    ADD CONSTRAINT "ppp_installments_status_chk"
    CHECK ("status" IN
      ('scheduled', 'paid', 'overdue', 'waived', 'action_required', 'failed'));
END
$$;
--> statement-breakpoint

-- Auto-charge feature flag — seeded OFF. The worker refuses to charge
-- unless this is on (belt-and-braces with the env cron gate).
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'billing.payment_plan_autocharge',
  false,
  'Auto-charge due patient payment-plan installments against the patient''s authorized card. Off by default.',
  'Billing'
)
ON CONFLICT (key) DO NOTHING;
