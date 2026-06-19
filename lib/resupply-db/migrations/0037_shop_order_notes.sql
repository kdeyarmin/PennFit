-- shop_order_notes — internal CSR-authored notes attached to a
-- specific shop_order row.
--
-- Mirrors shop_customer_notes (migration 0035) but keyed on the
-- order rather than the customer. Why a separate table from the
-- customer notes:
--   * Notes about delivery problems, address corrections, refund
--     reasons, partial-shipment rationale belong WITH the order so
--     they survive even when the customer has many orders.
--   * The CSR working a fulfillment issue wants the note tied to
--     the artifact they're triaging, not the person.
--   * Audit verb is `shop_order.note.create` (distinct from
--     `shop_customer.note.create`) so reviewers can grep cleanly.
--
-- Append-only, internal-only, never rendered on any customer-facing
-- page. The body is plain text and the audit log records the write
-- structurally (order_id + body_length) but NEVER the body.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_order_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" text NOT NULL REFERENCES "resupply"."shop_orders"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "author_email" text NOT NULL,
  "author_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shop_order_notes_order_created_idx"
  ON "resupply"."shop_order_notes" ("order_id", "created_at" DESC);
