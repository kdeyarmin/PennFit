-- shop_return_notes — internal CSR-authored notes attached to a
-- specific shop_returns row.
--
-- Mirrors shop_order_notes (migration 0037) but keyed on the return.
-- Why a separate table from shop_customer_notes / shop_order_notes:
--   * Returns triage has its own decision-driven workflow
--     (approved/denied/replaced/refunded) and CSRs need rationale
--     tied to the return artifact, not the order or the customer.
--   * Audit verb is `shop_return.note.create` (distinct from
--     `shop_order.note.create`) so reviewers can grep cleanly.
--   * Returns may outlive their parent order (RESTRICT on FK) so
--     notes about RMA state changes belong with the return row.
--
-- Append-only, internal-only, never rendered on any customer-facing
-- page. The body is plain text; the audit log records the write
-- structurally (return_id + body_length) but NEVER the body.
--
-- Per ADR 003 — versioned hand-authored migration.

CREATE TABLE IF NOT EXISTS "resupply"."shop_return_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "return_id" text NOT NULL REFERENCES "resupply"."shop_returns"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "author_email" text NOT NULL,
  "author_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "shop_return_notes_return_created_idx"
  ON "resupply"."shop_return_notes" ("return_id", "created_at" DESC);
