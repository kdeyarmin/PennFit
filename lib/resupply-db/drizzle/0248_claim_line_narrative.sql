-- 0248_claim_line_narrative — line-level narrative for the 837P NTE
-- segment (DME accuracy gap A1 in the DME billing research doc).
--
-- Medicare DME (and most commercial DME payers) REQUIRE a narrative
-- describing the item — plus its MSRP — on any claim line that bills a
-- miscellaneous / not-otherwise-classified HCPCS (E1399, A9999, K0108,
-- …). Without it the line denies as unprocessable. The 837P builder
-- already emits a loop-2400 `NTE*ADD` segment when a line carries a
-- `note` (see lib/resupply-integrations-office-ally/src/edi/837p.ts);
-- this column is where that note is stored and read from at batch-build
-- time (artifacts/.../lib/billing/office-ally-batch.ts).
--
-- Distinct from the existing `description` (an internal, human-readable
-- label) and the claim-header `notes` (internal CSR notes that must NOT
-- reach the payer): `narrative` is patient-/payer-facing claim text and
-- is the ONLY one of the three that is transmitted on the wire. Capped
-- at the X12 NTE02 length (80 chars) by the API + EDI builder.
--
-- Additive + idempotent: a nullable column, safe to apply to a populated
-- table; existing lines read back as NULL → no NTE emitted → byte-
-- identical 837P output for every claim that doesn't set it.

ALTER TABLE resupply.insurance_claim_line_items
  ADD COLUMN IF NOT EXISTS narrative text;

COMMENT ON COLUMN resupply.insurance_claim_line_items.narrative IS
  'Payer-facing 837P line narrative (loop 2400 NTE*ADD). Required by Medicare DME for miscellaneous/NOC HCPCS (item description + MSRP). NULL = no NTE emitted. Capped at 80 chars (X12 NTE02).';
