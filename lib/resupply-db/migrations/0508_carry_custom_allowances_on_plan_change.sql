-- 0508_carry_custom_allowances_on_plan_change — stop a plan change from
-- silently discarding a tenant's negotiated allowances.
--
-- The bug
-- -------
-- Both plan-change RPCs (0389) work by cancelling the live subscription row
-- and inserting a fresh one. They carefully carry the Stripe linkage
-- forward from `v_prior` — customer id, subscription id, period, last
-- invoice — because losing it would double-bill. They do NOT carry
-- `custom_allowances`:
--
--   * `swap_tenant_subscription` omits the column from its INSERT entirely,
--     so the new row takes the table default ('{}').
--   * `assign_tenant_subscription` writes
--     COALESCE(p_custom_allowances, '{}'), and the platform console never
--     sends that field (console.tsx reads customAllowances for display and
--     never posts it), so every save from the UI resets it.
--
-- That was survivable while `custom_allowances` was decorative — nothing
-- read it for billing. It is not survivable now that it is authoritative
-- for overage (see artifacts/resupply-api/src/lib/platform-billing/
-- allowances.ts): a negotiated or unlimited tenant would quietly revert to
-- the marketed caps the first time anyone touched their plan, and the only
-- symptom would be an overage charge nobody meant to make.
--
-- The fix
-- -------
-- Carry `custom_allowances` forward exactly like the Stripe linkage.
--
--   * `swap_tenant_subscription` (no allowance parameter — it is the
--     self-serve/signup path) now copies v_prior's value.
--   * `assign_tenant_subscription` now treats a SQL NULL parameter as
--     "leave unchanged" rather than "reset": COALESCE(p_custom_allowances,
--     v_prior.custom_allowances, '{}'). An explicit '{}' from a caller
--     still clears the override, so a platform admin can deliberately put a
--     tenant back on plan pricing. The route is updated in the same commit
--     to pass NULL instead of '{}' when the field is absent from the body.
--
-- Both bodies are otherwise byte-for-byte the deployed definitions
-- (verified against pg_get_functiondef before writing this file); the only
-- changes are the allowance carry-forward and its comments. Signatures are
-- unchanged, so no callers break and no GRANTs need re-issuing.
--
-- Idempotent: CREATE OR REPLACE. Per ADR 003 — versioned hand-authored
-- migration.

CREATE OR REPLACE FUNCTION resupply.swap_tenant_subscription(
  p_org_id uuid,
  p_plan_id uuid,
  p_updated_by_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_prior resupply.tenant_billing_subscriptions;
  v_new_id uuid;
BEGIN
  -- Serialize all plan changes for THIS tenant before touching any row.
  -- The FOR UPDATE below locks only the CURRENT active row, so under READ
  -- COMMITTED two overlapping swaps can lock different row generations: the
  -- first cancels the old row and inserts a new active one; the second swap's
  -- SELECT then matches neither the old (now canceled) nor the freshly
  -- inserted row — losing the carried Stripe linkage and risking a duplicate
  -- Stripe subscription. A per-org transaction-scoped advisory lock makes the
  -- second swap wait until the first fully commits, then reselect the current
  -- row. Released automatically at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));

  -- Capture (and lock) the live subscription being replaced, if any.
  SELECT * INTO v_prior
  FROM resupply.tenant_billing_subscriptions
  WHERE org_id = p_org_id
    AND status IN ('active', 'trialing', 'past_due')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  -- Cancel every currently-live row, moving the Stripe linkage off them so
  -- the partial UNIQUE index on stripe_subscription_id (0363) doesn't block
  -- the carry-forward insert below.
  UPDATE resupply.tenant_billing_subscriptions
  SET status = 'canceled',
      updated_at = now(),
      updated_by_email = p_updated_by_email,
      stripe_customer_id = NULL,
      stripe_subscription_id = NULL,
      stripe_account_ref = NULL,
      stripe_status = NULL,
      current_period_start = NULL,
      current_period_end = NULL,
      last_invoice_id = NULL,
      last_invoice_status = NULL
  WHERE org_id = p_org_id
    AND status IN ('active', 'trialing', 'past_due');

  -- Insert the new active row, carrying the prior Stripe identity forward
  -- (v_prior's fields are NULL when there was no prior subscription), and
  -- the prior custom_allowances with it — a plan change must not silently
  -- revoke a negotiated or unlimited allowance (0508).
  INSERT INTO resupply.tenant_billing_subscriptions (
    org_id, plan_id, status, notes, updated_by_email, custom_allowances,
    stripe_customer_id, stripe_subscription_id, stripe_account_ref,
    stripe_status, current_period_start, current_period_end,
    last_invoice_id, last_invoice_status
  ) VALUES (
    p_org_id, p_plan_id, 'active', '', p_updated_by_email,
    COALESCE(v_prior.custom_allowances, '{}'::jsonb),
    v_prior.stripe_customer_id, v_prior.stripe_subscription_id,
    v_prior.stripe_account_ref, v_prior.stripe_status,
    v_prior.current_period_start, v_prior.current_period_end,
    v_prior.last_invoice_id, v_prior.last_invoice_status
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION resupply.assign_tenant_subscription(
  p_org_id uuid,
  p_plan_id uuid,
  p_status text,
  p_custom_monthly_price_cents integer,
  p_custom_onboarding_fee_cents integer,
  p_custom_allowances jsonb,
  p_notes text,
  p_updated_by_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_prior resupply.tenant_billing_subscriptions;
  v_new_id uuid;
BEGIN
  -- Serialize concurrent same-tenant plan changes (see swap_tenant_
  -- subscription above for the full rationale): FOR UPDATE alone locks only
  -- the current active row and can lose the carried Stripe linkage under
  -- overlapping READ COMMITTED swaps. The per-org advisory xact lock makes a
  -- second swap wait for the first to commit. Released at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org_id::text, 0));

  SELECT * INTO v_prior
  FROM resupply.tenant_billing_subscriptions
  WHERE org_id = p_org_id
    AND status IN ('active', 'trialing', 'past_due')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  UPDATE resupply.tenant_billing_subscriptions
  SET status = 'canceled',
      updated_at = now(),
      updated_by_email = p_updated_by_email,
      stripe_customer_id = NULL,
      stripe_subscription_id = NULL,
      stripe_account_ref = NULL,
      stripe_status = NULL,
      current_period_start = NULL,
      current_period_end = NULL,
      last_invoice_id = NULL,
      last_invoice_status = NULL
  WHERE org_id = p_org_id
    AND status IN ('active', 'trialing', 'past_due');

  INSERT INTO resupply.tenant_billing_subscriptions (
    org_id, plan_id, status,
    custom_monthly_price_cents, custom_onboarding_fee_cents, custom_allowances,
    notes, updated_by_email,
    stripe_customer_id, stripe_subscription_id, stripe_account_ref,
    stripe_status, current_period_start, current_period_end,
    last_invoice_id, last_invoice_status
  ) VALUES (
    p_org_id, p_plan_id, p_status,
    p_custom_monthly_price_cents, p_custom_onboarding_fee_cents,
    -- NULL parameter = "leave the tenant's allowances alone" (0508). An
    -- explicit '{}' still clears the override back to plan pricing.
    COALESCE(p_custom_allowances, v_prior.custom_allowances, '{}'::jsonb),
    COALESCE(p_notes, ''), p_updated_by_email,
    v_prior.stripe_customer_id, v_prior.stripe_subscription_id,
    v_prior.stripe_account_ref, v_prior.stripe_status,
    v_prior.current_period_start, v_prior.current_period_end,
    v_prior.last_invoice_id, v_prior.last_invoice_status
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END
$$;
