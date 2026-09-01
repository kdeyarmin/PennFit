-- 0544_ship_date_exception_claim_correction — a corrected ship date on a
-- BILLED fulfillment cannot be closed until the claim is corrected too.
--
-- THE GAP
-- -------
-- `shipment_date_exceptions` exists for one situation: a shipment import
-- carries a ship date that disagrees with the one already on file, and
-- the one already on file has gone out on a claim as the date of
-- service. That is a billing disagreement, so it is held for a person
-- rather than applied.
--
-- Resolving it as `corrected` rewrites `fulfillments.shipped_at` and
-- closes the row. The claim was neither corrected nor required to have
-- been: the route deliberately does not re-submit one, because that is a
-- billing decision with its own approval gate.
--
-- But closing the exception removes it from the work queue. So the end
-- state was the fulfillment showing the new date, the filed 837P still
-- carrying the old one, and nothing left watching the difference — which
-- is precisely the hidden disagreement this table was added to surface.
-- The workflow could quietly manufacture the problem it exists to catch.
--
-- WHAT THIS ADDS
-- --------------
-- `claim_correction_ref`: the operator's reference for the corrected or
-- voided claim — a corrected-claim control number, a payer call
-- reference, whatever the practice actually files under.
--
-- A CHECK makes it mandatory in exactly the case that matters: resolving
-- `corrected` when a claim is attached. Not free text in
-- `resolution_note`, because a reference nobody can query is a reference
-- nobody will find; and not enforced only in the route, because the
-- database is the one place that cannot be bypassed by a second caller.
--
-- This deliberately FORCES AN ORDER: correct the claim first, then close
-- the exception citing it. The reverse order is what left the two
-- records disagreeing with nothing tracking it.
--
-- Every other resolution is untouched. `kept_recorded` (the import was
-- wrong), `duplicate_report` and `invalid_report` change no date and
-- need no claim work.
--
-- PHI: an operator-supplied billing reference. No patient identifier, no
-- clinical detail.

ALTER TABLE "resupply"."shipment_date_exceptions"
  ADD COLUMN IF NOT EXISTS "claim_correction_ref" text;
--> statement-breakpoint

-- Existing rows are left alone: the constraint is added NOT VALID so it
-- governs new writes without failing on any exception resolved before
-- this rule existed. Those historical rows are exactly the population
-- the gap produced, and rewriting them would invent evidence that was
-- never collected.
DO $$ BEGIN
  ALTER TABLE "resupply"."shipment_date_exceptions"
    ADD CONSTRAINT "shipment_date_exceptions_corrected_needs_claim_ref"
    CHECK (
      "resolution" IS DISTINCT FROM 'corrected'
      OR "claim_id" IS NULL
      OR ("claim_correction_ref" IS NOT NULL
          AND length(btrim("claim_correction_ref")) >= 3)
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- The open queue, oldest first — what /admin/pacware reads. Unchanged in
-- meaning; added here because the exception list is now the only place a
-- pending claim correction is visible.
CREATE INDEX IF NOT EXISTS "shipment_date_exceptions_open_created_idx"
  ON "resupply"."shipment_date_exceptions" ("org_id", "created_at")
  WHERE "status" = 'open';
