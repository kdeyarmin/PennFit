-- Migration 0061: Migrate fulfillments.quantity from text to integer (D-08).
-- The column has always stored a numeric quantity; text was the original
-- column type from the Pacware CSV integration where quantities came in as
-- strings. All existing values are castable via USING quantity::integer.
--
-- The default changes from '1' (text) to 1 (integer) — semantically
-- identical, just correctly typed.

-- Drop the existing text default ('1') BEFORE the type change. Postgres
-- does not auto-cast a column's DEFAULT expression to the new type, so
-- `ALTER COLUMN quantity TYPE integer` fails with "default for column
-- quantity cannot be cast automatically to type integer" while the text
-- default is still attached (the USING clause only converts existing row
-- values, not the default). Drop, retype, then re-set the typed default.
ALTER TABLE resupply.fulfillments
  ALTER COLUMN quantity DROP DEFAULT;

ALTER TABLE resupply.fulfillments
  ALTER COLUMN quantity TYPE integer USING quantity::integer,
  ALTER COLUMN quantity SET DEFAULT 1;
