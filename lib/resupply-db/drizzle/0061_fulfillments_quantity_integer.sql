-- Migration 0061: Migrate fulfillments.quantity from text to integer (D-08).
-- The column has always stored a numeric quantity; text was the original
-- column type from the Pacware CSV integration where quantities came in as
-- strings. All existing values are castable via USING quantity::integer.
--
-- The default changes from '1' (text) to 1 (integer) — semantically
-- identical, just correctly typed.

ALTER TABLE resupply.fulfillments
  ALTER COLUMN quantity TYPE integer USING quantity::integer,
  ALTER COLUMN quantity SET DEFAULT 1;
