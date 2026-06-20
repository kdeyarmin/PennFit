-- Patient signature packet — Medicare / insurance compliance fields.
--
-- Adds the data CMS and commercial payers expect on a signed DME
-- document set:
--
--   patient_packets.delivery_details
--     JSONB snapshot of the itemized equipment for the Proof of Delivery
--     document (CMS requires a detailed description of the items, the
--     delivery address, and the delivery date on a compliant POD).
--     Shape: { items: [{ description, hcpcs?, quantity? }],
--              deliveryDate?, deliveryAddress?, orderRef? }
--
--   patient_packet_signatures.signer_reason
--     When a document is signed by someone other than the beneficiary,
--     Medicare requires the reason the beneficiary could not sign to be
--     recorded alongside the representative's relationship.
--
--   patient_packet_signatures.date_received
--     The date the beneficiary actually received the equipment — a
--     required field on a Medicare Proof of Delivery, distinct from the
--     date the document was signed.

ALTER TABLE "resupply"."patient_packets"
  ADD COLUMN IF NOT EXISTS "delivery_details" jsonb;

ALTER TABLE "resupply"."patient_packet_signatures"
  ADD COLUMN IF NOT EXISTS "signer_reason" text,
  ADD COLUMN IF NOT EXISTS "date_received" date;
