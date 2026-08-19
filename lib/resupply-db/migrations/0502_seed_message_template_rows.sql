-- 0502_seed_message_template_rows — the paired seeds for the five
-- renderMessage template keys that shipped without one (rx_renewal.email /
-- .sms / .push, shop.back_in_stock.email, appointment.assigned.email).
--
-- Until now these renderers always took their hard-coded fallback path and
-- the Message Templates admin page had nothing to list or customize for
-- them (its API is deliberately GET/PATCH-only — rows come from seeds).
-- Each body below interpolates the pre-rendered fragment variables its
-- dispatcher supplies ({{headline}}, {{price_line_text}},
-- {{location_row_html}}, {{brand_*}}, ...), so the seeded output is
-- byte-identical to the fallback renderers.
--
-- SOURCE OF TRUTH pairing: these strings are generated from (and drift-
-- tested against) artifacts/resupply-api/src/lib/message-templates/
-- seed-bodies.ts — see seed-bodies.migration-drift.test.ts. Copy changes
-- need BOTH a new corrective migration and a seed-bodies.ts update; this
-- file is immutable once shipped (M1).
--
-- Ownership: the seed org (the global-unique (template_key, channel)
-- index admits one row per pair; the render lookup resolves non-seed
-- tenants to their fallback renderers, which carry tenant branding via
-- the same variables). INSERT ... SELECT no-ops if the seed org is absent;
-- ON CONFLICT DO NOTHING keeps re-runs and hand-edited rows safe.
--
-- Per ADR 003 — versioned hand-authored migration.

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'rx_renewal.email',
  'email',
  $tpl${{subject_line}}$tpl$,
  $tpl$<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">{{greeting_html}},</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">{{headline_html}}</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">{{brand_legal_name_html}}</p>
    </td></tr>
  </table>
</body></html>$tpl$,
  $tpl${{greeting}},

{{headline}}

We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.

If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.

— {{brand_legal_name}}
$tpl$,
  '["first_name","days_until_expiry","greeting","greeting_html","subject_line","headline","headline_html","brand_name","brand_legal_name","brand_legal_name_html"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO NOTHING;
--> statement-breakpoint

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
ON CONFLICT ("template_key", "channel") DO NOTHING;
--> statement-breakpoint

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
ON CONFLICT ("template_key", "channel") DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'shop.back_in_stock.email',
  'email',
  $tpl$Back in stock: {{product_name}}$tpl$,
  $tpl$<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a24a;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">{{brand_name_html}} · Back in stock</div>
          <div style="font-size:22px;color:#0a1f44;font-weight:700;margin-top:4px;">{{product_name_html}} is available again</div>
        </td></tr>
        {{image_block_html}}
        <tr><td style="padding-top:18px;color:#333;font-size:15px;line-height:1.55;">
          Good news — the item you asked us to watch is back in stock at {{brand_name_html}}. Stock can run low quickly, so grab one while it's available.
          {{price_block_html}}
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="{{product_url_html}}" style="display:inline-block;background:#c9a24a;color:#0a1f44;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">View product</a>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
          You're receiving this because you signed up for a back-in-stock alert at {{brand_name_html}}. We'll only email you once per signup.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>$tpl$,
  $tpl${{product_name}} is back in stock at {{brand_name}}.
{{price_line_text}}
Stock can run low quickly, so grab one while it's available:
{{product_url}}

You're receiving this because you signed up for a back-in-stock alert at {{brand_name}}. We only email once per signup.$tpl$,
  '["product_name","product_name_html","product_url","product_url_html","price_label","price_line_text","image_block_html","price_block_html","brand_name","brand_name_html"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO NOTHING;
--> statement-breakpoint

INSERT INTO "resupply"."message_templates"
  ("template_key", "channel", "subject", "body_html", "body_text", "allowed_variables", "is_active", "org_id")
SELECT
  'appointment.assigned.email',
  'email',
  $tpl$An appointment was scheduled for you$tpl$,
  $tpl$<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f4ec;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;max-width:560px;">
        <tr><td style="padding-bottom:16px;border-bottom:2px solid #c9a24a;">
          <div style="font-size:13px;letter-spacing:0.08em;color:#7a5d00;text-transform:uppercase;font-weight:600;">{{brand_name_html}} · Company calendar</div>
          <div style="font-size:22px;color:#0a1f44;font-weight:700;margin-top:4px;">An appointment was scheduled for you</div>
        </td></tr>
        <tr><td style="padding-top:18px;color:#333;font-size:15px;line-height:1.55;">
          Hi {{assignee_name_html}}, a new appointment has been placed on your calendar.
        </td></tr>
        <tr><td style="padding-top:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;">
            <tr><td style="padding:2px 0;color:#888;">Type</td><td style="padding:2px 0 2px 16px;color:#0a1f44;font-weight:600;">{{appointment_type_html}}</td></tr>
            <tr><td style="padding:2px 0;color:#888;">When</td><td style="padding:2px 0 2px 16px;color:#0a1f44;font-weight:600;">{{when_html}}</td></tr>
            {{location_row_html}}
            {{assigned_by_row_html}}
          </table>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;">
          <a href="{{dashboard_url_html}}" style="display:inline-block;background:#c9a24a;color:#0a1f44;text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:700;">Open the calendar</a>
        </td></tr>
        <tr><td style="padding-top:28px;border-top:1px solid #eee;color:#888;font-size:12px;line-height:1.4;">
          You're receiving this because a teammate assigned this appointment to you in the {{brand_name_html}} admin console.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>$tpl$,
  $tpl$Hi {{assignee_name}},

An appointment has been scheduled for you on the company calendar.

Type: {{appointment_type}}
When: {{appointment_date}}, {{appointment_time}}
{{location_line_text}}{{assigned_by_line_text}}
View it in your dashboard: {{dashboard_url}}

— {{brand_name}}$tpl$,
  '["assignee_name","assignee_name_html","appointment_date","appointment_time","appointment_type","appointment_type_html","when_html","location","assigned_by","location_line_text","assigned_by_line_text","location_row_html","assigned_by_row_html","dashboard_url","dashboard_url_html","brand_name","brand_name_html"]'::jsonb,
  true,
  o."id"
FROM "resupply"."organizations" o
WHERE o."slug" = 'penn-home-medical'
ON CONFLICT ("template_key", "channel") DO NOTHING;
