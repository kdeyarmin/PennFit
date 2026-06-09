-- 0256_patient_autopay — patient-controlled card-on-file + autopay.
--
-- Lets a signed-in patient save a card in the portal ("add a card for
-- future charges") and, separately and optionally, switch ON autopay so
-- their outstanding patient-responsibility balance is charged
-- automatically against that card. This is the patient-initiated cousin
-- of the CSR-driven payment-plan autopay (migration 0255): same Stripe
-- setup-mandate consent model, but keyed to the patient's whole balance
-- rather than a single installment schedule.
--
-- Consent model (off-session mandate), mirrors 0255:
--   * The patient starts a Stripe Checkout *setup* session (mode=setup)
--     from /account/billing. Stripe's hosted page captures the standard
--     off-session recurring-charge mandate consent text.
--   * On completion the webhook stores the Stripe customer + payment
--     method + card crumbs and stamps authorized_at. The card is now
--     "on file" — but NOTHING is charged automatically yet.
--   * autopay_enabled is a SEPARATE, patient-controlled boolean (default
--     FALSE). The patient flips it from the portal; only then is the
--     balance eligible for auto-charge.
--
-- Safety: auto-charging is additionally gated by the seeded-OFF
-- billing.patient_autopay feature flag below AND an env cron var on the
-- worker, so nothing charges in dev / preview or until an operator turns
-- it on — exactly the three-independent-switches model 0255 established.
--
-- Plain columns (no RLS) — service-role client only. Per ADR 003 —
-- versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."patient_autopay_authorizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL
    REFERENCES "resupply"."patients"("id") ON DELETE CASCADE,
  -- The shop_customers.customer_id (auth user key) that authorized this.
  -- Nullable so a future CSR-on-behalf flow without a portal account
  -- still fits. Stamped from the setup-session metadata by the webhook.
  "shop_customer_id" uuid,
  -- Stripe customer + the mandated payment method the patient authorized.
  "stripe_customer_id" text NOT NULL,
  "stripe_payment_method_id" text NOT NULL,
  -- Card crumbs for display in the portal (never the PAN — Stripe holds
  -- that). Refreshed whenever the patient swaps in a new card.
  "card_brand" text,
  "card_last4" varchar(4),
  "card_exp_month" integer,
  "card_exp_year" integer,
  -- The patient-controlled autopay switch. FALSE = card is on file but
  -- nothing auto-charges; the patient must opt in.
  "autopay_enabled" boolean NOT NULL DEFAULT false,
  -- When the card-on-file mandate was captured (Stripe setup completed).
  "authorized_at" timestamp with time zone NOT NULL DEFAULT now(),
  "autopay_enabled_at" timestamp with time zone,
  "autopay_disabled_at" timestamp with time zone,
  -- Set when the patient removes the card / revokes. The single ACTIVE
  -- authorization for a patient is the row with revoked_at IS NULL.
  "revoked_at" timestamp with time zone,
  -- Auto-charge attempt bookkeeping (mirrors the installment model in
  -- 0255). Reset to 0 on a successful charge; capped by the worker so a
  -- declining card isn't hammered every tick.
  "charge_attempts" integer NOT NULL DEFAULT 0,
  "last_charge_error" text,
  "last_charge_attempt_at" timestamp with time zone,
  -- Who captured/changed it: "customer:<email>" or a CSR email.
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- At most ONE active (non-revoked) authorization per patient. Adding a
-- new card updates the existing active row in place; removing it stamps
-- revoked_at, freeing the slot for a future card.
CREATE UNIQUE INDEX IF NOT EXISTS "patient_autopay_active_uniq"
  ON "resupply"."patient_autopay_authorizations" ("patient_id")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- Worker scan: enabled, non-revoked authorizations.
CREATE INDEX IF NOT EXISTS "patient_autopay_enabled_idx"
  ON "resupply"."patient_autopay_authorizations" ("autopay_enabled")
  WHERE "revoked_at" IS NULL;
--> statement-breakpoint

-- Reverse lookup for the payment_method.detached webhook (a patient who
-- removes the card via Stripe's own Customer Portal).
CREATE INDEX IF NOT EXISTS "patient_autopay_pm_idx"
  ON "resupply"."patient_autopay_authorizations" ("stripe_payment_method_id");
--> statement-breakpoint

-- Allow 'autopay' as a patient_payments.source so an auto-charge writes a
-- distinguishable history row (the portal + CSR views can label it).
DO $$
BEGIN
  ALTER TABLE "resupply"."patient_payments"
    DROP CONSTRAINT IF EXISTS "patient_payments_source_enum";
  ALTER TABLE "resupply"."patient_payments"
    ADD CONSTRAINT "patient_payments_source_enum"
    CHECK ("source" IN ('portal', 'csr', 'mail_in_check', 'external', 'autopay'));
END
$$;
--> statement-breakpoint

-- Auto-charge feature flag — seeded OFF. The worker refuses to charge
-- unless this is on (belt-and-braces with the env cron gate). Keep in
-- sync with FEATURE_FLAG_KEYS in
-- artifacts/resupply-api/src/lib/feature-flags.ts.
INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES (
  'billing.patient_autopay',
  false,
  'Auto-charge a patient''s outstanding balance against the card they saved and authorized in the patient portal. Off by default; each patient also controls their own autopay toggle.',
  'Billing'
)
ON CONFLICT (key) DO NOTHING;
