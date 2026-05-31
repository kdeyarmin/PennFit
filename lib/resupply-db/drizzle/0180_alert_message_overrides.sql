-- Per-patient overrides for the alert library (sister to
-- 0179_alert_library.sql, mirroring the message-template-override
-- pattern in 0068).
--
-- The alert library (alert_definitions + alert_messages) is the
-- GLOBAL copy. This table lets an operator deviate the copy for ONE
-- patient on ONE channel — e.g. a patient who asked for plain-text
-- only, or a VIP who gets bespoke wording. Override fields are
-- independently nullable: a partial override (just the SMS body)
-- inherits the not-overridden fields from the global alert message.
-- is_active=false suppresses the alert entirely for that patient on
-- that channel.
--
-- Why patient_id (not shop_customers.customer_id): the alert dispatch
-- path (artifacts/resupply-api/src/lib/alerts/dispatch.ts) is
-- patient-centric — it takes a resupply.patients.id and sends to that
-- patient's email/phone. Keying overrides on patient_id lets the
-- dispatcher layer override-on-global with no identity hop. (The
-- message-template overrides key on shop_customers.customer_id because
-- that render path is storefront-customer-centric; alerts are not.)
--
-- Journal posture (per CLAUDE.md): NOT added to meta/_journal.json.
-- The dispatch path's override lookup is wrapped so a missing table
-- degrades to the global alert message — forward-deploy-safe before
-- this migration is applied.

CREATE TABLE IF NOT EXISTS "resupply"."alert_message_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_id" uuid NOT NULL,
  "alert_key" text NOT NULL,
  "channel" text NOT NULL,
  "subject" text,
  "body_html" text,
  "body_text" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" text,
  CONSTRAINT "alert_message_overrides_channel_enum"
    CHECK ("channel" IN ('email', 'sms', 'voice')),
  CONSTRAINT "alert_message_overrides_subject_max_length"
    CHECK ("subject" IS NULL OR length("subject") <= 1000),
  CONSTRAINT "alert_message_overrides_body_html_max_length"
    CHECK ("body_html" IS NULL OR length("body_html") <= 200000),
  CONSTRAINT "alert_message_overrides_body_text_max_length"
    CHECK ("body_text" IS NULL OR length("body_text") <= 50000),
  CONSTRAINT "alert_message_overrides_note_max_length"
    CHECK ("note" IS NULL OR length("note") <= 2000),
  CONSTRAINT "alert_message_overrides_alert_key_fk"
    FOREIGN KEY ("alert_key") REFERENCES "resupply"."alert_definitions" ("key")
    ON DELETE CASCADE
);

-- At most one override per (patient, alert, channel). Doubles as the
-- index the dispatch lookup hits on every patient-targeted send.
CREATE UNIQUE INDEX IF NOT EXISTS "alert_message_overrides_unique_idx"
  ON "resupply"."alert_message_overrides" ("patient_id", "alert_key", "channel");
