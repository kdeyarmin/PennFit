-- shop_returns — comfort-guarantee swap / refund / RMA tracking for the
-- cash-pay storefront.
--
-- Why a dedicated table (vs. overloading shop_orders.status):
--   shop_orders.status tracks the PAYMENT lifecycle (pending → paid →
--   refunded). A return is a NEW workflow that links to the original
--   paid order and has its own multi-step lifecycle (requested →
--   approved → shipped_back → received → refunded/replaced/closed).
--   Modelling it separately keeps the order row immutable from the
--   customer's perspective and lets a single order spawn multiple
--   returns (defective cushion + wrong-size headgear, two RMAs).
--
-- Why a single `status` enum-text column rather than a state machine
-- or boolean flags:
--   The lifecycle is linear with a single branch at "received" (refund
--   vs. replace). Encoding it as text + a per-row index supports the
--   high-frequency admin queue ("show me everything in `requested`")
--   and the customer detail view in one cheap lookup.
--
-- All timestamp columns are nullable + populated as the row advances
-- through its states. Their NOT-NULLNESS encodes the state transitions
-- so analytics can compute "median days from request to refund" in
-- one window function without joining an event log.
--
-- Per ADR 003 — versioned hand-authored migration; this codebase does
-- not use db:push because db:push silently rewrites columns once PHI
-- lands. (No PHI on this surface — cash-pay shop only — but the rule
-- is global.)

CREATE TABLE IF NOT EXISTS "resupply"."shop_returns" (
  "id" text PRIMARY KEY DEFAULT (gen_random_uuid()::text) NOT NULL,
  "clerk_user_id" text NOT NULL,
  "order_id" text NOT NULL REFERENCES "resupply"."shop_orders"("id") ON DELETE RESTRICT,
  "stripe_session_id" text NOT NULL,

  -- Lifecycle: requested → approved → shipped_back → received →
  -- (refunded | replaced | closed)
  -- "rejected" branches off "requested" before the workflow advances.
  "status" text NOT NULL DEFAULT 'requested',

  -- Customer-supplied reason category + free-form note. Both are
  -- captured at request-time and never edited (admin notes go in
  -- admin_note).
  "reason" text NOT NULL,
  "reason_note" text,

  -- Resolution decided by the admin once the parcel comes back.
  --   refund        — Stripe Refund (full or partial)
  --   exchange      — replacement order created; original price refunded
  --                   only if the exchange product is cheaper, otherwise
  --                   a delta charge would be required (out of scope v1).
  --   store_credit  — credit memo issued (out of scope v1; reserved enum
  --                   value to avoid a future schema migration)
  "resolution" text,

  -- Refund details (populated when resolution = refund).
  "refund_cents" integer,
  "stripe_refund_id" text,

  -- Exchange details (populated when resolution = exchange).
  "exchange_product_id" text,
  "exchange_price_id" text,
  "exchange_order_id" text REFERENCES "resupply"."shop_orders"("id") ON DELETE SET NULL,

  -- Return label / inbound tracking. Issued by ops via a manual workflow
  -- in v1 (carrier shopping app) and pasted into the admin form. A
  -- future iteration would generate via ShipStation / EasyPost.
  "return_label_url" text,
  "return_carrier" text,
  "return_tracking_number" text,

  -- Free-form admin notes (concatenated history, latest at top). Capped
  -- at 8KB at the API layer.
  "admin_note" text,
  "admin_clerk_id" text,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Lifecycle stamps (each populated when status transitions in).
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "shipped_back_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "closed_at" timestamp with time zone
);

-- Customer queue: "show me MY returns sorted newest-first."
CREATE INDEX IF NOT EXISTS "shop_returns_clerk_user_id_idx"
  ON "resupply"."shop_returns" ("clerk_user_id", "created_at" DESC);

-- Admin queue: filter by status, newest first. The default landing
-- tab on the queue is `requested`, which has the highest churn rate;
-- the index covers status-filter scans in one access path.
CREATE INDEX IF NOT EXISTS "shop_returns_status_idx"
  ON "resupply"."shop_returns" ("status", "created_at" DESC);

-- "Did this order already have an open return?" lookup, used by the
-- customer-side initiation endpoint to refuse duplicate requests for
-- the SAME order while one is still in flight. Partial so it costs
-- nothing on closed/resolved rows (the bulk of historical data).
CREATE INDEX IF NOT EXISTS "shop_returns_open_per_order_idx"
  ON "resupply"."shop_returns" ("order_id")
  WHERE "status" IN ('requested', 'approved', 'shipped_back', 'received');
