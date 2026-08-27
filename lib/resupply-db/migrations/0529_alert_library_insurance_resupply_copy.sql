-- 0529: Retire self-checkout wording on resupply_due + back_in_stock alerts.
--
-- Patient cash-pay checkout is gone. The alert catalog still told patients to
-- "place your order", "Manage your order", "Grab one", or "visit our store".
-- Rewrite to insurance confirm / contact language. Variable names
-- (manage_url, product_url) are unchanged so existing send paths keep working.
--
-- Tables: alert_messages (seeded in 0179). Pattern matches 0526.
--
-- Idempotent: UPDATE … WHERE alert_key IN (...).

UPDATE "resupply"."alert_messages"
SET
  "subject" = 'Your {{practice_name}} CPAP supplies are due',
  "body_html" =
    '<p>Hi {{first_name}},</p><p>Your {{item_name}} is due for resupply on {{due_date}}. Confirm your shipment here: <a href="{{manage_url}}">{{manage_url}}</a>. Reply to this email or call us with questions.</p><p>— {{practice_name}}</p>',
  "body_text" =
    'Hi {{first_name}}, your {{item_name}} is due for resupply on {{due_date}}. Confirm your shipment: {{manage_url}} — {{practice_name}}'
WHERE "alert_key" = 'resupply_due' AND "channel" = 'email';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, it is {{practice_name}}. Your {{item_name}} is due for resupply. Reply YES to ship or visit {{manage_url}}. Reply STOP to opt out.'
WHERE "alert_key" = 'resupply_due' AND "channel" = 'sms';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, this is a message from {{practice_name}}. Your C-PAP supplies are due for resupply. Please call us back or open the link in your text or email to confirm shipment. Thank you.'
WHERE "alert_key" = 'resupply_due' AND "channel" = 'voice';

UPDATE "resupply"."alert_messages"
SET
  "subject" = '{{product_name}} is available again',
  "body_html" =
    '<p>Hi {{first_name}},</p><p>The item you asked us to watch, {{product_name}}, is available again. Contact us so we can help with insurance fulfillment: <a href="{{product_url}}">{{product_url}}</a>.</p><p>— {{practice_name}}</p>',
  "body_text" =
    'Hi {{first_name}}, {{product_name}} is available again at {{practice_name}}. Contact us for insurance fulfillment: {{product_url}}'
WHERE "alert_key" = 'back_in_stock' AND "channel" = 'email';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, {{product_name}} is available again at {{practice_name}}. Contact us: {{product_url}}'
WHERE "alert_key" = 'back_in_stock' AND "channel" = 'sms';

UPDATE "resupply"."alert_messages"
SET
  "body_text" =
    'Hi {{first_name}}, this is {{practice_name}}. The item you asked us to watch is available again. Please call us or check your email so we can help with insurance fulfillment. Thank you.'
WHERE "alert_key" = 'back_in_stock' AND "channel" = 'voice';
