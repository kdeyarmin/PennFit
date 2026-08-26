-- 0526: Retire "update your payment method" wording on payment_failed.
--
-- Patient cash-pay / card-on-file was removed. The alert library entry and
-- channel templates still told patients to open an update-payment URL. Rewrite
-- to insurance-balance language and point them at /account/billing (or a
-- contact CTA) instead. Variables keep `update_payment_url` for back-compat
-- with any admin-sent overrides that still pass that key; new default copy
-- uses `billing_url`.
--
-- Idempotent: UPDATE … WHERE alert_key = 'payment_failed'.

UPDATE "resupply"."alert_library"
SET
  "name" = 'Billing balance notice',
  "description" =
    'Alert a patient about an insurance billing balance that needs attention.',
  "variables" =
    '["first_name","practice_name","amount","billing_url"]'::jsonb,
  "updated_at" = NOW()
WHERE "key" = 'payment_failed';

UPDATE "resupply"."alert_messages"
SET
  "subject" = 'Action needed: billing notice from {{practice_name}}',
  "body_html" =
    '<p>Hi {{first_name}},</p><p>Our records show an open balance of {{amount}} on your insurance account. Review your statements here: <a href="{{billing_url}}">{{billing_url}}</a>. If you have questions, reply to this email or call us.</p><p>— {{practice_name}}</p>',
  "body_text" =
    'Hi {{first_name}}, our records show an open balance of {{amount}} on your insurance account. Review your statements: {{billing_url}}. Reply or call us with questions. — {{practice_name}}'
WHERE "alert_key" = 'payment_failed' AND "channel" = 'email';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, {{practice_name}}: open insurance balance of {{amount}}. Review statements: {{billing_url}}'
WHERE "alert_key" = 'payment_failed' AND "channel" = 'sms';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, this is {{practice_name}}. Our records show an open balance on your insurance account. Please check your email or call us to review your statements. Thank you.'
WHERE "alert_key" = 'payment_failed' AND "channel" = 'voice';
