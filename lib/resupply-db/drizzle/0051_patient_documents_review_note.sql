-- Optional CSR note recorded when a document is marked reviewed.
--
-- A short free-text field (500 chars) so CSRs can record context:
--   "Insurance card verified — expires 12/2026"
--   "Requested renewal, Rx expired"
--   "Duplicate of doc uploaded 2026-03-01"
--
-- Nullable — not every document requires a note, and existing rows
-- (marked reviewed before this migration) carry no note naturally.
--
-- Per ADR 003 — versioned hand-authored migration.

ALTER TABLE "resupply"."patient_documents"
  ADD COLUMN "review_note" varchar(500);
