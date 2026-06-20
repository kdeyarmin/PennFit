-- 0389_swap_tenant_subscription_rpc — make a tenant plan-change atomic.
--
-- POST /admin/billing/subscription (routes/platform/billing.ts) used to do
-- a cancel-then-insert in TWO separate PostgREST calls with no transaction:
--   1. UPDATE the current subscription -> 'canceled' (committed), then
--   2. INSERT the new 'active' row.
-- If step 2 failed (constraint / transient error) the cancel had already
-- committed and the tenant was left with ZERO current subscriptions — they
-- stop being billed and lose plan entitlements until manual repair. Two
-- concurrent double-clicks could also both reach the insert and one would
-- violate the `tenant_billing_one_current_plan_uq` partial unique index.
--
-- This function does the whole swap in ONE transaction (PostgREST runs each
-- request in a transaction, and a RAISE inside the function rolls back every
-- statement), and takes `FOR UPDATE` on the row being replaced so concurrent
-- swaps serialize. Net effect: the swap either fully succeeds or leaves the
-- prior subscription untouched — never a stranded tenant, never two current
-- rows.
--
-- Carries the prior Stripe linkage forward onto the new row so the
-- subsequent syncTenantStripeSubscription() UPDATES the existing Stripe
-- subscription (swapping line items) instead of creating a second one — and
-- moves it OFF the canceled row first so the partial UNIQUE index on
-- stripe_subscription_id (0363) doesn't block the carry-forward insert.
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
  -- (v_prior's fields are NULL when there was no prior subscription).
  INSERT INTO resupply.tenant_billing_subscriptions (
    org_id, plan_id, status, notes, updated_by_email,
    stripe_customer_id, stripe_subscription_id, stripe_account_ref,
    stripe_status, current_period_start, current_period_end,
    last_invoice_id, last_invoice_status
  ) VALUES (
    p_org_id, p_plan_id, 'active', '', p_updated_by_email,
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
GRANT EXECUTE ON FUNCTION
  resupply.swap_tenant_subscription(uuid, uuid, text) TO service_role;
--> statement-breakpoint

-- ── assign_tenant_subscription — the platform-admin PUT variant ──
-- PUT /platform/billing/tenants/:id/subscription had the SAME non-atomic
-- cancel-then-insert, plus it carries the operator-chosen status + custom
-- pricing + custom allowances + notes. Same atomicity + FOR UPDATE
-- serialization guarantees as swap_tenant_subscription above; the extra
-- parameters preserve this route's richer semantics exactly.
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
    COALESCE(p_custom_allowances, '{}'::jsonb),
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
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resupply.assign_tenant_subscription(
  uuid, uuid, text, integer, integer, jsonb, text, text
) TO service_role;
