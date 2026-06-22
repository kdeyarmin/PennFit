-- 0454 — inventory reservations: idempotent-retry reuse + RPC grant hardening.
--
-- Two fixes on top of 0434:
--
-- (1) Idempotent-retry reuse (P2). A client retrying the SAME checkout (same
--     `Idempotency-Key`) before the first Session response is delivered would,
--     under 0434, take a SECOND hold for the same cart. For a last-unit SKU the
--     retry then saw the FIRST hold counting against availability and was
--     refused with 409 out_of_stock — instead of being handed the existing
--     Session that Stripe itself dedupes by idempotency key. We now key each
--     hold to the route's namespaced idempotency key and have
--     `reserve_inventory` RETURN THE EXISTING active hold for the same
--     (org, sku, idempotency_key) rather than inserting a duplicate. So a retry
--     reuses its own hold and proceeds to the (deduped) Stripe Session, exactly
--     as the non-retry path would.
--
-- (2) RPC grant hardening (Fix 4). 0434 only `GRANT EXECUTE ... TO service_role`
--     on the SECURITY DEFINER `reserve_inventory`, leaving Postgres's default
--     PUBLIC execute grant in place — so `anon`/`authenticated` (the PostgREST
--     roles) could in principle invoke a definer-privileged function. We REVOKE
--     the PUBLIC/anon/authenticated grants before re-granting to service_role
--     only. Idempotent: REVOKE of an absent grant is a no-op.
--
-- Note: 0434 is already applied-in-CI, so this lands as a NEW migration rather
-- than an edit to 0434 (ADR 003).

-- service_role guard — vanilla Postgres (CI replay) has no such role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- The namespaced idempotency key the checkout routes compute (per customer/IP +
-- client Idempotency-Key + cart hash + mode). NULL on holds taken before this
-- migration / when no key is plumbed; such holds never participate in reuse.
ALTER TABLE resupply.inventory_reservations
  ADD COLUMN IF NOT EXISTS idempotency_key text;
--> statement-breakpoint

-- Reuse-lookup index: the hot path is "find the still-active hold for this
-- (org, sku, idempotency_key)". Partial on active rows + non-null key keeps it
-- tiny. Not UNIQUE: the advisory lock in reserve_inventory already serializes
-- concurrent reservers per (org, sku), and a unique constraint would turn a
-- benign duplicate into a hard error rather than the intended reuse.
CREATE INDEX IF NOT EXISTS inventory_reservations_org_sku_idem_active_idx
  ON resupply.inventory_reservations (org_id, sku, idempotency_key)
  WHERE status = 'active' AND idempotency_key IS NOT NULL;
--> statement-breakpoint

-- Atomic reserve, now idempotency-key aware. Returns the new (or existing,
-- on retry) reservation id, or NULL if granting the hold would exceed
-- `p_available` (the caller treats NULL as "oversold").
CREATE OR REPLACE FUNCTION resupply.reserve_inventory(
  p_org_id uuid,
  p_sku text,
  p_qty int,
  p_available int,
  p_expires_at timestamptz,
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_reserved int;
  v_id uuid;
BEGIN
  -- Serialize concurrent reservers for THIS (org, sku) for the duration of
  -- the surrounding transaction (PostgREST = one txn per RPC), so the
  -- read-sum-then-insert below is atomic against another reserver.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_org_id::text || ':' || p_sku, 0)
  );

  -- Idempotent retry: if an active hold already exists for this exact
  -- (org, sku, idempotency_key), reuse it instead of taking a second hold.
  -- This is what stops a client retry (same Idempotency-Key) from being
  -- refused with a phantom oversell on a last-unit SKU — the retry rides the
  -- existing hold straight to the (Stripe-deduped) Session.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id
      INTO v_id
      FROM resupply.inventory_reservations
     WHERE org_id = p_org_id
       AND sku = p_sku
       AND idempotency_key = p_idempotency_key
       AND status = 'active'
       AND expires_at > now()
     ORDER BY created_at
     LIMIT 1;

    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT COALESCE(SUM(quantity), 0)
    INTO v_reserved
    FROM resupply.inventory_reservations
   WHERE org_id = p_org_id
     AND sku = p_sku
     AND status = 'active'
     AND expires_at > now();

  IF v_reserved + p_qty > p_available THEN
    RETURN NULL;
  END IF;

  INSERT INTO resupply.inventory_reservations (
    org_id, sku, quantity, status, expires_at, idempotency_key
  ) VALUES (
    p_org_id, p_sku, p_qty, 'active', p_expires_at, p_idempotency_key
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;
--> statement-breakpoint

-- Grant hardening (Fix 4): strip Postgres's default PUBLIC execute grant (and
-- the PostgREST anon/authenticated roles) from this SECURITY DEFINER function
-- before re-granting to service_role only. Idempotent — REVOKE of an absent
-- grant is a no-op. Covers BOTH the new 6-arg signature and the original
-- 5-arg signature from 0434 (CREATE OR REPLACE above only replaces the body
-- of the matching signature; the 5-arg overload still exists until dropped).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION
      resupply.reserve_inventory(uuid, text, int, int, timestamptz)
      FROM anon;
    REVOKE EXECUTE ON FUNCTION
      resupply.reserve_inventory(uuid, text, int, int, timestamptz, text)
      FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION
      resupply.reserve_inventory(uuid, text, int, int, timestamptz)
      FROM authenticated;
    REVOKE EXECUTE ON FUNCTION
      resupply.reserve_inventory(uuid, text, int, int, timestamptz, text)
      FROM authenticated;
  END IF;
END
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  resupply.reserve_inventory(uuid, text, int, int, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION
  resupply.reserve_inventory(uuid, text, int, int, timestamptz, text)
  FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  resupply.reserve_inventory(uuid, text, int, int, timestamptz, text)
  TO service_role;
--> statement-breakpoint

-- Drop the now-superseded 5-arg overload so only the idempotency-aware
-- signature remains (avoids an ambiguous-overload surprise and leaves no
-- PUBLIC-executable definer function behind). Safe: the application only ever
-- calls the 6-arg form after this migration.
DROP FUNCTION IF EXISTS
  resupply.reserve_inventory(uuid, text, int, int, timestamptz);
