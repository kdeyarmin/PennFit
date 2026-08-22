-- 0513_rebrand_message_template_rows — re-point the five seeded
-- message-template rows (0502) at the shared CareMetric Breathe email
-- design system.
--
-- Why: the renderers behind these keys (rx_renewal.email,
-- shop.back_in_stock.email, appointment.assigned.email) used to hand-roll
-- their own HTML in a cream/gold palette that existed nowhere else in the
-- product. They now compose the shared branded layout
-- (`renderBrandedEmail`), so the SEEDED rows — which take precedence over
-- the fallback renderers for the org that owns them — must be re-stated or
-- that org would keep sending the retired design.
--
-- 0502 is immutable (M1), so this is the "new corrective migration" its
-- header calls for. Bodies are generated from (and drift-tested against)
-- artifacts/resupply-api/src/lib/message-templates/seed-bodies.ts.
--
-- Safety: ON CONFLICT DO UPDATE ... WHERE "updated_by" IS NULL. The admin
-- PATCH stamps updated_by, so a row an operator has hand-edited is left
-- exactly as they left it; only untouched seed rows are re-pointed. The
-- INSERT arm still covers databases that never received 0502's row.
--
-- The sms/push rows are unchanged in content but re-stated here so the
-- drift guard has a single file to compare the seed module against.
--
-- Per ADR 003 — versioned hand-authored migration.


INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'rx_renewal.email',
  'email',
  $tpl${{subject_line}}$tpl$,
  $tpl$<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{{brand_legal_name_html}}</title>
<!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#eef2fb;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#eef2fb;">{{headline}}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2fb;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(11,20,38,0.08);">
<!-- Header -->
<tr><td style="background:#0b1426;background:linear-gradient(135deg,#0b1426 0%,#11203c 100%);padding:28px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left">
<div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.01em;">{{brand_legal_name_html}}</div>

</td>
<td align="right" style="vertical-align:middle;">
<span style="display:inline-block;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#54c8ff 0%,#2f6fe6 100%);"></span>
</td></tr></table>
</td></tr>
<!-- Accent rule -->
<tr><td style="height:4px;background:linear-gradient(90deg,#54c8ff 0%,#2f6fe6 50%,#f6a722 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
<!-- Body -->
<tr><td style="padding:40px;font-family:Arial,Helvetica,sans-serif;">
<h1 style="margin:0 0 20px;color:#0b1426;font-size:24px;line-height:1.3;font-weight:700;">Time to renew your prescription</h1><p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">{{greeting_html}},</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">{{headline_html}}</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician&#39;s office for a renewal — most clinics turn this around in 1-2 business days.</p>
<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">If you&#39;d rather have us request the renewal directly from your physician, reply to this email with your physician&#39;s name + practice and we&#39;ll handle the outreach.</p>

</td></tr>
<!-- Footer -->
<tr><td style="padding:24px 40px 32px;border-top:1px solid #e6eaf3;font-family:Arial,Helvetica,sans-serif;">
<div style="margin:0 0 6px;color:#9aa6be;font-size:12px;line-height:1.5;">{{brand_legal_name_html}}</div>
<div style="margin:8px 0 0;color:#9aa6be;font-size:12px;line-height:1.5;">© {{copyright_year}} {{brand_legal_name_html}}. All rights reserved.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$tpl$,
  $tpl${{greeting}},

{{headline}}

We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.

If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.

— {{brand_legal_name}}
$tpl$,
  '["first_name","days_until_expiry","greeting","greeting_html","subject_line","headline","headline_html","brand_name","brand_legal_name","brand_legal_name_html","copyright_year"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "body_html" = EXCLUDED."body_html",
  "body_text" = EXCLUDED."body_text",
  "allowed_variables" = EXCLUDED."allowed_variables",
  "updated_at" = now()
WHERE "message_templates"."updated_by" IS NULL;

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'rx_renewal.sms',
  'sms',
  NULL,
  NULL,
  $tpl${{sms_greeting}}, {{rx_status_clause}}. Ask your doctor to renew or text us their name + practice. Reply STOP to opt out. - {{brand_name}}$tpl$,
  '["first_name","days_until_expiry","sms_greeting","rx_status_clause","brand_name","brand_legal_name"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "body_html" = EXCLUDED."body_html",
  "body_text" = EXCLUDED."body_text",
  "allowed_variables" = EXCLUDED."allowed_variables",
  "updated_at" = now()
WHERE "message_templates"."updated_by" IS NULL;

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'rx_renewal.push',
  'push',
  NULL,
  NULL,
  $tpl${{push_title}}$tpl$,
  '["first_name","days_until_expiry","push_title","brand_name"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "body_html" = EXCLUDED."body_html",
  "body_text" = EXCLUDED."body_text",
  "allowed_variables" = EXCLUDED."allowed_variables",
  "updated_at" = now()
WHERE "message_templates"."updated_by" IS NULL;

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'shop.back_in_stock.email',
  'email',
  $tpl$Back in stock: {{product_name}}$tpl$,
  $tpl$<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{{brand_name_html}}</title>
<!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#eef2fb;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#eef2fb;">{{product_name_html}} is back in stock at {{brand_name_html}}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2fb;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(11,20,38,0.08);">
<!-- Header -->
<tr><td style="background:#0b1426;background:linear-gradient(135deg,#0b1426 0%,#11203c 100%);padding:28px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left">
<div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.01em;">{{brand_name_html}}</div>
<div style="margin:6px 0 0;color:#54c8ff;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">Back in stock</div>
</td>
<td align="right" style="vertical-align:middle;">
<span style="display:inline-block;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#54c8ff 0%,#2f6fe6 100%);"></span>
</td></tr></table>
</td></tr>
<!-- Accent rule -->
<tr><td style="height:4px;background:linear-gradient(90deg,#54c8ff 0%,#2f6fe6 50%,#f6a722 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
<!-- Body -->
<tr><td style="padding:40px;font-family:Arial,Helvetica,sans-serif;">
<h1 style="margin:0 0 20px;color:#0b1426;font-size:24px;line-height:1.3;font-weight:700;">{{product_name_html}} is available again</h1>{{image_block_html}}<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">Good news — the item you asked us to watch is back in stock at {{brand_name_html}}. Stock can run low quickly, so grab one while it&#39;s available.</p>{{price_block_html}}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:12px 0 8px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 8px;"><tr><td align="center" bgcolor="#2f6fe6" style="border-radius:10px;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{product_url_html}}" style="height:48px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="#2f6fe6">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">View product</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="{{product_url_html}}" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;background:#2f6fe6;">View product</a>
<!--<![endif]-->
</td></tr></table></td></tr></table>
</td></tr>
<!-- Footer -->
<tr><td style="padding:24px 40px 32px;border-top:1px solid #e6eaf3;font-family:Arial,Helvetica,sans-serif;">
<div style="margin:0 0 6px;color:#9aa6be;font-size:12px;line-height:1.5;">You&#39;re receiving this because you signed up for a back-in-stock alert at {{brand_name_html}}. We&#39;ll only email you once per signup.</div>
<div style="margin:8px 0 0;color:#9aa6be;font-size:12px;line-height:1.5;">© {{copyright_year}} {{brand_name_html}}. All rights reserved.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$tpl$,
  $tpl${{product_name}} is back in stock at {{brand_name}}.
{{price_line_text}}
Stock can run low quickly, so grab one while it's available:
{{product_url}}

You're receiving this because you signed up for a back-in-stock alert at {{brand_name}}. We only email once per signup.$tpl$,
  '["product_name","product_name_html","product_url","product_url_html","price_label","price_line_text","image_block_html","price_block_html","brand_name","brand_name_html","copyright_year"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "body_html" = EXCLUDED."body_html",
  "body_text" = EXCLUDED."body_text",
  "allowed_variables" = EXCLUDED."allowed_variables",
  "updated_at" = now()
WHERE "message_templates"."updated_by" IS NULL;

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'appointment.assigned.email',
  'email',
  $tpl$An appointment was scheduled for you$tpl$,
  $tpl$<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>{{brand_name_html}}</title>
<!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#eef2fb;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#eef2fb;">{{appointment_type}} on {{when_plain}}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef2fb;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(11,20,38,0.08);">
<!-- Header -->
<tr><td style="background:#0b1426;background:linear-gradient(135deg,#0b1426 0%,#11203c 100%);padding:28px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left">
<div style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.01em;">{{brand_name_html}}</div>
<div style="margin:6px 0 0;color:#54c8ff;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">Company calendar</div>
</td>
<td align="right" style="vertical-align:middle;">
<span style="display:inline-block;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#54c8ff 0%,#2f6fe6 100%);"></span>
</td></tr></table>
</td></tr>
<!-- Accent rule -->
<tr><td style="height:4px;background:linear-gradient(90deg,#54c8ff 0%,#2f6fe6 50%,#f6a722 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
<!-- Body -->
<tr><td style="padding:40px;font-family:Arial,Helvetica,sans-serif;">
<h1 style="margin:0 0 20px;color:#0b1426;font-size:24px;line-height:1.3;font-weight:700;">An appointment was scheduled for you</h1><p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.6;">Hi {{assignee_name_html}}, a new appointment has been placed on your calendar.</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;font-family:Arial,Helvetica,sans-serif;margin:0 0 8px;">
<tr><td style="padding:2px 0;color:#6b7280;">Type</td><td style="padding:2px 0 2px 16px;color:#0b1426;font-weight:600;">{{appointment_type_html}}</td></tr>
<tr><td style="padding:2px 0;color:#6b7280;">When</td><td style="padding:2px 0 2px 16px;color:#0b1426;font-weight:600;">{{when_html}}</td></tr>
{{location_row_html}}{{assigned_by_row_html}}</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:12px 0 8px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 8px;"><tr><td align="center" bgcolor="#2f6fe6" style="border-radius:10px;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{dashboard_url_html}}" style="height:48px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="#2f6fe6">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">Open the calendar</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="{{dashboard_url_html}}" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;background:#2f6fe6;">Open the calendar</a>
<!--<![endif]-->
</td></tr></table></td></tr></table>
</td></tr>
<!-- Footer -->
<tr><td style="padding:24px 40px 32px;border-top:1px solid #e6eaf3;font-family:Arial,Helvetica,sans-serif;">
<div style="margin:0 0 6px;color:#9aa6be;font-size:12px;line-height:1.5;">You&#39;re receiving this because a teammate assigned this appointment to you in the {{brand_name_html}} admin console.</div>
<div style="margin:8px 0 0;color:#9aa6be;font-size:12px;line-height:1.5;">© {{copyright_year}} {{brand_name_html}}. All rights reserved.</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>$tpl$,
  $tpl$Hi {{assignee_name}},

An appointment has been scheduled for you on the company calendar.

Type: {{appointment_type}}
When: {{appointment_date}}, {{appointment_time}}
{{location_line_text}}{{assigned_by_line_text}}
View it in your dashboard: {{dashboard_url}}

— {{brand_name}}$tpl$,
  '["assignee_name","assignee_name_html","appointment_date","appointment_time","appointment_type","appointment_type_html","when_html","location","assigned_by","location_line_text","assigned_by_line_text","location_row_html","assigned_by_row_html","dashboard_url","dashboard_url_html","brand_name","brand_name_html","when_plain","copyright_year"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO UPDATE SET
  "subject" = EXCLUDED."subject",
  "body_html" = EXCLUDED."body_html",
  "body_text" = EXCLUDED."body_text",
  "allowed_variables" = EXCLUDED."allowed_variables",
  "updated_at" = now()
WHERE "message_templates"."updated_by" IS NULL;
