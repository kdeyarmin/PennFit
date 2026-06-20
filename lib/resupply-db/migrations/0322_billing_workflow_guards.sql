-- Tighten the end-to-end billing workflow:
--   1. Retire legacy auto-workflow placeholder statements so they cannot be sent.
--   2. Prevent two open claims from being created for the same fulfillment.
--   3. Support the rendered-statement send and mail queues.

UPDATE "resupply"."patient_billing_statements"
SET
  "delivery_status" = 'skipped',
  "delivery_error" = COALESCE(
    "delivery_error",
    'Auto-workflow placeholder retired; regenerate a rendered statement before sending.'
  )
WHERE "generated_by_email" = 'system:auto_workflow'
  AND "delivery_status" = 'pending'
  AND (
    "statement_pdf_object_key" IS NULL
    OR CASE
      WHEN jsonb_typeof("line_items_json") = 'array'
        THEN jsonb_array_length("line_items_json") = 0
      ELSE true
    END
  );
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "insurance_claims_open_fulfillment_uidx"
  ON "resupply"."insurance_claims" ("fulfillment_id")
  WHERE "fulfillment_id" IS NOT NULL
    AND "status" NOT IN ('denied', 'closed');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_billing_statements_rendered_electronic_pending_idx"
  ON "resupply"."patient_billing_statements" ("delivery_status", "created_at")
  WHERE "delivery_status" = 'pending'
    AND "statement_pdf_object_key" IS NOT NULL
    AND "total_patient_responsibility_cents" > 0
    AND ("delivery_method" IS NULL OR "delivery_method" <> 'mail');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "patient_billing_statements_rendered_mail_pending_idx"
  ON "resupply"."patient_billing_statements" ("delivery_status", "created_at")
  WHERE "delivery_status" = 'pending'
    AND "statement_pdf_object_key" IS NOT NULL
    AND "total_patient_responsibility_cents" > 0
    AND "delivery_method" = 'mail';
