-- Alert library — a curated catalog of operational/clinical alerts that
-- staff can send to a patient over email, SMS, or an automated phone
-- call, each backed by an editable per-channel message.
--
-- Two tables:
--   * alert_definitions — the catalog. One row per alert "kind"
--     (resupply due, order shipped, payment failed, …). Carries the
--     human-facing name/description, a category + severity for the
--     admin UI, the channels the alert supports, and the allowlist of
--     {{snake_case}} variables its messages may reference.
--   * alert_messages — the editable copy. One row per
--     (alert_key, channel). Email rows carry subject + body_html +
--     body_text; sms/voice rows carry body_text only (the spoken
--     transcript for voice). Admins edit these via
--     /admin/alerts without a deploy.
--
-- Substitution is the same fixed-syntax {{snake_case_var}} the rest of
-- the message library uses (see lib/resupply-templates) — variables
-- outside the alert's allowed_variables stay literal so a typo is
-- visible in QA rather than shipped to a patient.
--
-- Journal posture (per CLAUDE.md): this file is NOT added to
-- meta/_journal.json. migrate.mjs dedups by file hash and runs each
-- SQL once. Forward-deploy safety: dispatchAlert() catches a missing
-- alert_definitions / alert_messages relation and returns a clean
-- `alert_not_found` / `message_not_configured` outcome (the admin
-- routes translate these to 404/409) rather than throwing a 500. So
-- the alerts router can be mounted before this migration is applied —
-- the surface is simply inert (no alert sends) until the tables exist.
-- There is no hard-coded message fallback; an unconfigured alert just
-- doesn't send.

CREATE TABLE IF NOT EXISTS "resupply"."alert_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "category" text NOT NULL DEFAULT 'general',
  "severity" text NOT NULL DEFAULT 'info',
  "channels" jsonb NOT NULL DEFAULT '["email","sms","voice"]'::jsonb,
  "allowed_variables" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" text,
  CONSTRAINT "alert_definitions_severity_enum"
    CHECK ("severity" IN ('info', 'warning', 'critical')),
  CONSTRAINT "alert_definitions_name_max_length" CHECK (length("name") <= 200),
  CONSTRAINT "alert_definitions_description_max_length"
    CHECK ("description" IS NULL OR length("description") <= 2000)
);

CREATE UNIQUE INDEX IF NOT EXISTS "alert_definitions_key_idx"
  ON "resupply"."alert_definitions" ("key");

CREATE INDEX IF NOT EXISTS "alert_definitions_active_category_idx"
  ON "resupply"."alert_definitions" ("is_active", "category");

CREATE TABLE IF NOT EXISTS "resupply"."alert_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_key" text NOT NULL,
  "channel" text NOT NULL,
  "subject" text,
  "body_html" text,
  "body_text" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" text,
  CONSTRAINT "alert_messages_channel_enum"
    CHECK ("channel" IN ('email', 'sms', 'voice')),
  CONSTRAINT "alert_messages_subject_max_length"
    CHECK ("subject" IS NULL OR length("subject") <= 1000),
  CONSTRAINT "alert_messages_body_html_max_length"
    CHECK ("body_html" IS NULL OR length("body_html") <= 200000),
  CONSTRAINT "alert_messages_body_text_max_length"
    CHECK (length("body_text") <= 50000),
  CONSTRAINT "alert_messages_alert_key_fk"
    FOREIGN KEY ("alert_key") REFERENCES "resupply"."alert_definitions" ("key")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "alert_messages_key_channel_idx"
  ON "resupply"."alert_messages" ("alert_key", "channel");

CREATE INDEX IF NOT EXISTS "alert_messages_active_key_idx"
  ON "resupply"."alert_messages" ("is_active", "alert_key");

-- ─────────────────────────────────────────────────────────────────
-- Seed: the starter alert library. Idempotent via ON CONFLICT so
-- re-running (or a from-scratch rebuild) leaves operator edits intact.
-- ─────────────────────────────────────────────────────────────────

INSERT INTO "resupply"."alert_definitions"
  ("key", "name", "description", "category", "severity", "channels", "allowed_variables")
VALUES
  ('resupply_due', 'Resupply due',
   'Let a patient know their CPAP supplies are due for reorder.',
   'resupply', 'info',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","item_name","due_date","manage_url"]'::jsonb),
  ('order_shipped', 'Order shipped',
   'Confirm an order has shipped and share tracking details.',
   'orders', 'info',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","order_number","carrier","tracking_number","tracking_url"]'::jsonb),
  ('order_delivered', 'Order delivered',
   'Confirm an order was delivered.',
   'orders', 'info',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","order_number"]'::jsonb),
  ('payment_failed', 'Payment failed',
   'Alert a patient that a payment did not go through and needs attention.',
   'billing', 'warning',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","amount","update_payment_url"]'::jsonb),
  ('appointment_reminder', 'Appointment reminder',
   'Remind a patient of an upcoming appointment.',
   'appointments', 'info',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","appointment_time","location","reschedule_url"]'::jsonb),
  ('prescription_expiring', 'Prescription expiring',
   'Notify a patient that a prescription is about to expire.',
   'clinical', 'warning',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","expires_on","renew_url"]'::jsonb),
  ('equipment_recall', 'Equipment recall notice',
   'Notify a patient of a manufacturer recall affecting their device.',
   'clinical', 'critical',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","device_name","recall_reference"]'::jsonb),
  ('back_in_stock', 'Back in stock',
   'Tell a patient a product they wanted is available again.',
   'shop', 'info',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","product_name","product_url"]'::jsonb),
  ('low_usage_checkin', 'Low therapy usage check-in',
   'Reach out to a patient whose therapy usage has dropped.',
   'clinical', 'warning',
   '["email","sms","voice"]'::jsonb,
   '["first_name","practice_name","nights_used","coach_phone"]'::jsonb)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "resupply"."alert_messages"
  ("alert_key", "channel", "subject", "body_html", "body_text")
VALUES
  -- resupply_due
  ('resupply_due', 'email',
   'Your {{practice_name}} CPAP supplies are due',
   '<p>Hi {{first_name}},</p><p>Your {{item_name}} is due for resupply on {{due_date}}. Manage your order here: <a href="{{manage_url}}">{{manage_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, your {{item_name}} is due for resupply on {{due_date}}. Manage your order: {{manage_url}} — {{practice_name}}'),
  ('resupply_due', 'sms', NULL, NULL,
   'Hi {{first_name}}, it is {{practice_name}}. Your {{item_name}} is due for resupply. Reply YES to ship or visit {{manage_url}}. Reply STOP to opt out.'),
  ('resupply_due', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is a message from {{practice_name}}. Your C-PAP supplies are due for resupply. Please call us back or visit your account to place your order. Thank you.'),
  -- order_shipped
  ('order_shipped', 'email',
   'Your {{practice_name}} order has shipped',
   '<p>Hi {{first_name}},</p><p>Good news — order {{order_number}} has shipped via {{carrier}}. Tracking number {{tracking_number}}. Track it here: <a href="{{tracking_url}}">{{tracking_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, order {{order_number}} has shipped via {{carrier}}. Tracking {{tracking_number}}: {{tracking_url}} — {{practice_name}}'),
  ('order_shipped', 'sms', NULL, NULL,
   'Hi {{first_name}}, your {{practice_name}} order {{order_number}} shipped via {{carrier}}. Track it: {{tracking_url}}'),
  ('order_shipped', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. Good news, your order {{order_number}} has shipped and is on its way. Check your email or text messages for tracking details. Thank you.'),
  -- order_delivered
  ('order_delivered', 'email',
   'Your {{practice_name}} order was delivered',
   '<p>Hi {{first_name}},</p><p>Order {{order_number}} has been delivered. If anything is missing or damaged, just reply and we will help.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, order {{order_number}} has been delivered. Reply if anything is missing or damaged. — {{practice_name}}'),
  ('order_delivered', 'sms', NULL, NULL,
   'Hi {{first_name}}, your {{practice_name}} order {{order_number}} was delivered. Reply if anything is missing or damaged.'),
  ('order_delivered', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. Your order {{order_number}} has been delivered. If anything is missing or damaged, please give us a call. Thank you.'),
  -- payment_failed
  ('payment_failed', 'email',
   'Action needed: payment issue on your {{practice_name}} account',
   '<p>Hi {{first_name}},</p><p>We were unable to process your payment of {{amount}}. Please update your payment method to avoid a delay: <a href="{{update_payment_url}}">{{update_payment_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, we could not process your payment of {{amount}}. Update your payment method: {{update_payment_url}} — {{practice_name}}'),
  ('payment_failed', 'sms', NULL, NULL,
   'Hi {{first_name}}, {{practice_name}} could not process your payment of {{amount}}. Please update it here: {{update_payment_url}}'),
  ('payment_failed', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. We were unable to process a recent payment on your account. Please call us back or check your email to update your payment method. Thank you.'),
  -- appointment_reminder
  ('appointment_reminder', 'email',
   'Reminder: your {{practice_name}} appointment',
   '<p>Hi {{first_name}},</p><p>This is a reminder of your appointment on {{appointment_time}} at {{location}}. Need to reschedule? <a href="{{reschedule_url}}">{{reschedule_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, reminder: your appointment is {{appointment_time}} at {{location}}. Reschedule: {{reschedule_url}} — {{practice_name}}'),
  ('appointment_reminder', 'sms', NULL, NULL,
   'Hi {{first_name}}, reminder from {{practice_name}}: appointment {{appointment_time}} at {{location}}. Reschedule: {{reschedule_url}}'),
  ('appointment_reminder', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}} with a reminder about your upcoming appointment on {{appointment_time}} at {{location}}. If you need to reschedule, please call us back. Thank you.'),
  -- prescription_expiring
  ('prescription_expiring', 'email',
   'Your prescription is expiring soon',
   '<p>Hi {{first_name}},</p><p>Your prescription on file expires on {{expires_on}}. Renew it now so your therapy is not interrupted: <a href="{{renew_url}}">{{renew_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, your prescription expires on {{expires_on}}. Renew it here: {{renew_url}} — {{practice_name}}'),
  ('prescription_expiring', 'sms', NULL, NULL,
   'Hi {{first_name}}, your {{practice_name}} prescription expires {{expires_on}}. Renew now: {{renew_url}}'),
  ('prescription_expiring', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. Your prescription on file is expiring soon. Please call us back so we can help you renew it and keep your therapy on track. Thank you.'),
  -- equipment_recall
  ('equipment_recall', 'email',
   'Important recall notice for your device',
   '<p>Hi {{first_name}},</p><p>This is a manufacturer recall notice from {{practice_name}} regarding your {{device_name}} (reference {{recall_reference}}). Please contact us so we can arrange next steps.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, this is a recall notice from {{practice_name}} for your {{device_name}} (ref {{recall_reference}}). Please contact us for next steps. — {{practice_name}}'),
  ('equipment_recall', 'sms', NULL, NULL,
   'Important: {{practice_name}} recall notice for your {{device_name}} (ref {{recall_reference}}). Please call us back so we can help with next steps.'),
  ('equipment_recall', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is an important recall notice from {{practice_name}} regarding your {{device_name}}. Please call us back at your earliest convenience so we can arrange next steps. Thank you.'),
  -- back_in_stock
  ('back_in_stock', 'email',
   '{{product_name}} is back in stock',
   '<p>Hi {{first_name}},</p><p>The item you asked us to watch, {{product_name}}, is back in stock. Grab one here: <a href="{{product_url}}">{{product_url}}</a>.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, {{product_name}} is back in stock at {{practice_name}}. Grab one: {{product_url}}'),
  ('back_in_stock', 'sms', NULL, NULL,
   'Hi {{first_name}}, {{product_name}} is back in stock at {{practice_name}}: {{product_url}}'),
  ('back_in_stock', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. The item you asked us to watch is back in stock. Check your email or visit our store to order. Thank you.'),
  -- low_usage_checkin
  ('low_usage_checkin', 'email',
   'Checking in on your therapy',
   '<p>Hi {{first_name}},</p><p>We noticed your therapy usage has dropped to about {{nights_used}} nights recently. We are here to help — call our coaching line at {{coach_phone}} any time.</p><p>— {{practice_name}}</p>',
   'Hi {{first_name}}, we noticed your therapy dropped to about {{nights_used}} nights. We are here to help — call {{coach_phone}}. — {{practice_name}}'),
  ('low_usage_checkin', 'sms', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}}. We noticed your therapy usage dropped recently. We are here to help — call {{coach_phone}}.'),
  ('low_usage_checkin', 'voice', NULL, NULL,
   'Hi {{first_name}}, this is {{practice_name}} checking in. We noticed your therapy usage has dropped recently and we would love to help. Please call our coaching line when you have a moment. Thank you.')
ON CONFLICT ("alert_key", "channel") DO NOTHING;
