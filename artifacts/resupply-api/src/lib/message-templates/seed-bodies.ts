// Seed bodies for the message-template library (migration 0502).
//
// The library's contract ("templates are seeded by code paired with each
// renderer" — see lib/admin/message-templates-api.ts in the SPA) was
// dropped after 0246: five renderers shipped templated via renderMessage
// but with no row to find, so the Message Templates admin page could
// never list or customize them. These constants are the paired seeds.
//
// TWO invariants, both enforced by tests:
//
//  1. BYTE PARITY — rendering each seeded body with the variables its
//     dispatcher actually supplies must produce exactly the bytes the
//     fallback renderer produces (*.seeded-template-parity.test.ts).
//     The conditional clauses (pluralized headlines, optional rows/lines)
//     arrive as pre-rendered `{{...}}` variables because the template
//     engine is fixed-syntax substitution with no conditionals.
//
//  2. MIGRATION DRIFT — migration 0502 embeds these exact strings
//     (dollar-quoted). seed-bodies.migration-drift.test.ts fails if the
//     .sql and this module ever disagree, so an edit to either side
//     without the other is caught at CI time. Remember migrations are
//     immutable once shipped (M1): future copy changes need BOTH a new
//     corrective migration AND an update here.
//
// The seeded rows belong to the seed org (the only org the global-unique
// (template_key, channel) index admits); other tenants keep the
// tenant-branded fallback renderers. `{{brand_*}}` variables — never
// literals — carry the brand, so a row stays correct for whichever org
// owns it.

import type { Channel } from "@workspace/resupply-templates";

export interface MessageTemplateSeed {
  templateKey: string;
  channel: Channel;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
  allowedVariables: readonly string[];
}

export const MESSAGE_TEMPLATE_SEEDS: readonly MessageTemplateSeed[] = [
  {
    templateKey: "rx_renewal.email",
    channel: "email",
    subject: "{{subject_line}}",
    bodyText:
      "{{greeting}},\n\n{{headline}}\n\nWe need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.\n\nIf you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.\n\n— {{brand_legal_name}}\n",
    bodyHtml: `<!doctype html>
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
</body></html>`,
    allowedVariables: [
      "first_name",
      "days_until_expiry",
      "greeting",
      "greeting_html",
      "subject_line",
      "headline",
      "headline_html",
      "brand_name",
      "brand_legal_name",
      "brand_legal_name_html",
    ],
  },
  {
    templateKey: "rx_renewal.sms",
    channel: "sms",
    subject: null,
    bodyHtml: null,
    bodyText:
      "{{sms_greeting}}, {{rx_status_clause}}. Ask your doctor to renew or text us their name + practice. Reply STOP to opt out. - {{brand_name}}",
    allowedVariables: [
      "first_name",
      "days_until_expiry",
      "sms_greeting",
      "rx_status_clause",
      "brand_name",
      "brand_legal_name",
    ],
  },
  {
    templateKey: "rx_renewal.push",
    channel: "push",
    subject: null,
    bodyHtml: null,
    bodyText: "{{push_title}}",
    allowedVariables: [
      "first_name",
      "days_until_expiry",
      "push_title",
      "brand_name",
    ],
  },
  {
    templateKey: "shop.back_in_stock.email",
    channel: "email",
    subject: "Back in stock: {{product_name}}",
    bodyText:
      "{{product_name}} is back in stock at {{brand_name}}.\n{{price_line_text}}\nStock can run low quickly, so grab one while it's available:\n{{product_url}}\n\nYou're receiving this because you signed up for a back-in-stock alert at {{brand_name}}. We only email once per signup.",
    bodyHtml: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
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
  </table></body></html>`,
    allowedVariables: [
      "product_name",
      "product_name_html",
      "product_url",
      "product_url_html",
      "price_label",
      "price_line_text",
      "image_block_html",
      "price_block_html",
      "brand_name",
      "brand_name_html",
    ],
  },
  {
    templateKey: "appointment.assigned.email",
    channel: "email",
    subject: "An appointment was scheduled for you",
    bodyText:
      "Hi {{assignee_name}},\n\nAn appointment has been scheduled for you on the company calendar.\n\nType: {{appointment_type}}\nWhen: {{appointment_date}}, {{appointment_time}}\n{{location_line_text}}{{assigned_by_line_text}}\nView it in your dashboard: {{dashboard_url}}\n\n— {{brand_name}}",
    bodyHtml: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f4ec;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
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
  </table></body></html>`,
    allowedVariables: [
      "assignee_name",
      "assignee_name_html",
      "appointment_date",
      "appointment_time",
      "appointment_type",
      "appointment_type_html",
      "when_html",
      "location",
      "assigned_by",
      "location_line_text",
      "assigned_by_line_text",
      "location_row_html",
      "assigned_by_row_html",
      "dashboard_url",
      "dashboard_url_html",
      "brand_name",
      "brand_name_html",
    ],
  },
];
