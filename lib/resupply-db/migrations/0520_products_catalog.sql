-- 0516_products_catalog — Postgres-backed product catalog + stock.
--
-- Why this exists:
--   The catalog used to live in Stripe. Product rows WERE Stripe Products
--   and the on-hand count WAS `product.metadata.stock_count`, so retiring
--   patient card payments took the SKU registry and inventory tracking with
--   it. Supplies are still dispensed against insurance, so the warehouse
--   still needs to know what a SKU is and how many are on the shelf — this
--   moves both onto the same Postgres the rest of the resupply engine uses.
--
-- Shape:
--   1. products             — the org-scoped SKU registry (name, category,
--                             manufacturer, on-hand count, reorder point).
--   2. product_stock_ledger — every movement, append-only, so a count can be
--                             explained rather than just observed.
--   3. adjust_product_stock — the ONLY supported way to move stock: an
--                             atomic update + ledger write behind a
--                             per-(org, sku) advisory lock.
--
-- The SKU is the join key the rest of the system already speaks:
-- `fulfillments.item_sku`, `product_hcpcs_map` (SKU → HCPCS for the claim),
-- `product_costs`, and `shop_sku_substitutes` are all keyed the same way.
-- This table is deliberately NOT a foreign key for those — they predate it
-- and may reference SKUs a tenant hasn't registered yet, and a hard FK would
-- turn an un-catalogued dispense into a failed fulfillment.
--
-- `stock_count IS NULL` means UNTRACKED, not zero: a tenant who doesn't want
-- the app counting a consumable leaves it null and nothing warns on it. That
-- mirrors the semantics the Stripe-metadata catalog used, so the
-- reconciliation table (0142) reads the same way it always did.

CREATE TABLE IF NOT EXISTS "resupply"."products" (
  "org_id" uuid NOT NULL
    REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "sku" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  -- Free text rather than an enum: the supply mix differs per tenant and a
  -- CHECK constraint here would need a migration every time one of them
  -- stocks something new. The app validates against its own category list.
  "category" text,
  "manufacturer" text,
  "model_number" text,
  "unit_of_measure" text NOT NULL DEFAULT 'each',
  -- NULL = untracked (see header). Never negative: a negative on-hand is a
  -- counting bug, and letting it persist quietly corrupts every downstream
  -- reorder decision.
  "stock_count" integer CHECK ("stock_count" IS NULL OR "stock_count" >= 0),
  "low_stock_threshold" integer
    CHECK ("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "sku")
);
--> statement-breakpoint

-- The catalog browser's default view: this tenant's active rows, by name.
CREATE INDEX IF NOT EXISTS "products_org_active_idx"
  ON "resupply"."products" ("org_id", "name")
  WHERE "active";
--> statement-breakpoint

-- Category filter on the same browser.
CREATE INDEX IF NOT EXISTS "products_org_category_idx"
  ON "resupply"."products" ("org_id", "category")
  WHERE "active";
--> statement-breakpoint

-- Append-only movement history. Every row is one change to on-hand, with
-- enough context to answer "why is this number what it is" months later.
CREATE TABLE IF NOT EXISTS "resupply"."product_stock_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL
    REFERENCES "resupply"."organizations"("id") ON DELETE CASCADE,
  "sku" text NOT NULL,
  -- Signed: negative dispenses, positive receives. Never zero — a no-op
  -- movement is noise in an audit trail.
  "delta" integer NOT NULL CHECK ("delta" <> 0),
  -- On-hand AFTER this movement. Denormalized on purpose: replaying the
  -- whole ledger to explain one number is exactly the work this avoids,
  -- and it also survives a later `count` reset that rebases the running sum.
  "balance_after" integer,
  "reason" text NOT NULL CHECK ("reason" IN (
    'receipt',     -- stock arrived from a supplier
    'dispense',    -- went out on a fulfillment
    'return',      -- came back from a patient
    'count',       -- physical count corrected the system number
    'adjustment'   -- anything else, `note` explains
  )),
  -- Free-form pointer at whatever caused this (fulfillment id, PO number,
  -- reconciliation id). Not an FK: the referent lives in different tables.
  "reference" text,
  "note" text,
  -- Staff email, same non-PHI attribution surface as audit rows.
  "actor_email" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The hot read: one SKU's recent history, newest first.
CREATE INDEX IF NOT EXISTS "product_stock_ledger_org_sku_created_idx"
  ON "resupply"."product_stock_ledger" ("org_id", "sku", "created_at" DESC);
--> statement-breakpoint

-- Move stock atomically and record why.
--
-- Read-modify-write from the app would lose a concurrent decrement (two
-- fulfillments shipping the same SKU at once both read 5, both write 4).
-- The advisory lock serializes callers for this (org, sku) for the
-- surrounding transaction — PostgREST runs one transaction per RPC — so the
-- read, the write, and the ledger insert are one unit.
--
-- Returns the new on-hand count, or NULL when the SKU is untracked
-- (stock_count IS NULL): an untracked SKU records the movement in the
-- ledger but has no balance to keep. Raises when the SKU isn't in the
-- catalog, or when the movement would drive on-hand negative — the caller
-- decides whether that's a hard error or a warning to a CSR.
CREATE OR REPLACE FUNCTION "resupply"."adjust_product_stock"(
  p_org_id uuid,
  p_sku text,
  p_delta int,
  p_reason text,
  p_reference text DEFAULT NULL,
  p_note text DEFAULT NULL,
  p_actor_email text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = resupply, pg_catalog
AS $$
DECLARE
  v_tracked boolean;
  v_current int;
  v_next int;
BEGIN
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'adjust_product_stock: delta must be non-zero';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_org_id::text || ':' || p_sku, 0)
  );

  SELECT (stock_count IS NOT NULL), stock_count
    INTO v_tracked, v_current
    FROM resupply.products
   WHERE org_id = p_org_id
     AND sku = p_sku;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'adjust_product_stock: unknown sku % for org %',
      p_sku, p_org_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tracked THEN
    v_next := v_current + p_delta;
    IF v_next < 0 THEN
      RAISE EXCEPTION
        'adjust_product_stock: % would drive on-hand negative (% + %)',
        p_sku, v_current, p_delta
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE resupply.products
       SET stock_count = v_next,
           updated_at = now()
     WHERE org_id = p_org_id
       AND sku = p_sku;
  ELSE
    v_next := NULL;
  END IF;

  INSERT INTO resupply.product_stock_ledger (
    org_id, sku, delta, balance_after, reason, reference, note, actor_email
  ) VALUES (
    p_org_id, p_sku, p_delta, v_next, p_reason, p_reference, p_note,
    p_actor_email
  );

  RETURN v_next;
END;
$$;
