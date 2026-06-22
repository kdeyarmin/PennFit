-- 0434 — inventory reservations / oversell guard for cash-pay checkout.
--
-- Background: shop stock lives in Stripe product metadata as `stock_count`
-- (point-in-time). The cart guard (lib/stripe/validate-cart.ts) reads it at
-- session-creation time and PR #1200 added a stock DECREMENT on the paid
-- webhook. The remaining gap is the window BETWEEN those two events:
-- multiple concurrent buyers can each pass validateCart against the same
-- live `stock_count`, all create Checkout sessions, and all complete →
-- oversell. There is no concurrency control between "validated" and "paid".
--
-- This migration adds a short-lived reservation ledger that closes that
-- window. A buyer reserves their requested units up front (within the same
-- request that passes validateCart); the reservation holds for a TTL and is
-- consumed on payment, released on cancel/expire, or swept to `expired` by a
-- cron once stale. The reservation count is added to the live `stock_count`
-- check so a second concurrent buyer sees the first buyer's hold and is
-- refused if it would oversell.
--
-- `resupply.reserve_inventory` serializes concurrent reservers PER (org, sku)
-- with a transaction-scoped advisory lock (PostgREST runs each RPC in its own
-- transaction, so the lock is held for the function's duration). Inside the
-- lock it sums the still-live active holds and refuses (returns NULL) if the
-- new quantity would exceed availability; otherwise it inserts the hold and
-- returns its id.
--
-- FAIL-OPEN posture (enforced in the calling helper, not here): any error in
-- the reservation path must NEVER block a sale — the worst case without this
-- guard is the pre-existing oversell behaviour, which is reconciled by the
-- monthly inventory count. Correctness here is "never oversell when the
-- system is healthy", not "block checkout when the ledger is unreachable".
--
-- `sku` is the Stripe PRODUCT id (the stock unit — `stock_count` is product
-- metadata, and a product can carry more than one price line, so the product
-- id is the right reservation key, mirroring the webhook's per-product debit).

-- service_role guard — vanilla Postgres (CI replay) has no such role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS resupply.inventory_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES resupply.organizations(id) ON DELETE CASCADE,
  sku text NOT NULL,
  quantity int NOT NULL CHECK (quantity > 0),
  checkout_session_id text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'consumed', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
--> statement-breakpoint

-- Partial index: the hot path is "sum the still-active holds for an
-- (org, sku)" inside reserve_inventory. Only active rows participate, so a
-- partial index keeps it small even as the table accumulates terminal rows.
CREATE INDEX IF NOT EXISTS inventory_reservations_org_sku_active_idx
  ON resupply.inventory_reservations (org_id, sku)
  WHERE status = 'active';
--> statement-breakpoint

-- Lookup by session id for the webhook consume/release + the route attach.
CREATE INDEX IF NOT EXISTS inventory_reservations_session_idx
  ON resupply.inventory_reservations (checkout_session_id);
--> statement-breakpoint

-- Atomic reserve. Returns the new reservation id, or NULL if granting the
-- hold would exceed `p_available` (the caller treats NULL as "oversold").
CREATE OR REPLACE FUNCTION resupply.reserve_inventory(
  p_org_id uuid,
  p_sku text,
  p_qty int,
  p_available int,
  p_expires_at timestamptz
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
    org_id, sku, quantity, status, expires_at
  ) VALUES (
    p_org_id, p_sku, p_qty, 'active', p_expires_at
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resupply.reserve_inventory(uuid, text, int, int, timestamptz)
  TO service_role;
