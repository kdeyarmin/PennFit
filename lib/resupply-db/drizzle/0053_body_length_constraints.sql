-- D-15: DB-level CHECK constraints on free-text body columns.
--
-- Application-layer Zod validates input length before it reaches the DB,
-- but raw SQL inserts (migrations, backfills, admin scripts) bypass Zod.
-- These constraints provide defence-in-depth — an accidental 100MB payload
-- cannot silently land in the table and bloat indexes.
--
-- Limit rationale (10,000 characters):
--   * SMS segments are 160 chars; multi-part SMS tops out well under 10,000.
--   * Email templates / macros rarely exceed a few thousand chars.
--   * CSR notes are operational records, not essays.
--   * 10,000 gives a comfortable headroom above actual use while capping
--     egregious abuse. Raise if a legitimate use case requires it.
--
-- All existing rows are within limits (Zod has enforced max at the API layer
-- since these tables were created), so no data backfill is required.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."messages"
  ADD CONSTRAINT "messages_body_max_length"
  CHECK (length(body) <= 10000);

ALTER TABLE "resupply"."patient_notes"
  ADD CONSTRAINT "patient_notes_body_max_length"
  CHECK (length(body) <= 10000);

ALTER TABLE "resupply"."csr_macros"
  ADD CONSTRAINT "csr_macros_body_max_length"
  CHECK (length(body) <= 10000);

ALTER TABLE "resupply"."shop_customer_notes"
  ADD CONSTRAINT "shop_customer_notes_body_max_length"
  CHECK (length(body) <= 10000);

ALTER TABLE "resupply"."shop_return_notes"
  ADD CONSTRAINT "shop_return_notes_body_max_length"
  CHECK (length(body) <= 10000);

ALTER TABLE "resupply"."shop_order_notes"
  ADD CONSTRAINT "shop_order_notes_body_max_length"
  CHECK (length(body) <= 10000);
