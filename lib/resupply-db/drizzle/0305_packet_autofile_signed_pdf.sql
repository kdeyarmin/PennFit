-- Auto-file the signed patient-packet PDF to the chart.
--
-- When a patient completes an e-sign packet, the signed PDF (documents
-- + signature certificate) is rendered and filed onto the patient's
-- chart automatically — the same artifact staff could already download
-- from the packet detail, without the manual download/upload round
-- trip. Filing is best-effort and never blocks the signing response.
--
--   * patient_packets.chart_document_id / chart_filed_at — which
--     patient_documents row holds the filed copy (idempotency guard +
--     admin UI affordance). Soft pointer, app-enforced.
--   * patient_packets.autofile_signed_pdf flag — seeded ON: filing is
--     internal record-keeping (no outbound communication), and the
--     unknown-key posture of the flag helper already reports enabled.

ALTER TABLE "resupply"."patient_packets"
  ADD COLUMN IF NOT EXISTS "chart_document_id" uuid,
  ADD COLUMN IF NOT EXISTS "chart_filed_at" timestamptz;

INSERT INTO resupply.feature_flags (key, enabled, description, category)
VALUES
  ('patient_packets.autofile_signed_pdf',
   true,
   'Automatically file the signed e-sign packet PDF (documents + signature certificate) onto the patient''s chart when the patient completes signing. Internal record-keeping only — no messages are sent. ON by default.',
   'Documents')
ON CONFLICT (key) DO NOTHING;
