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

import { backInStockBrandedHtml } from "../back-in-stock-email";
import { appointmentAssignedBrandedHtml } from "../calendar/appointment-assigned-email";
import { rxRenewalBrandedHtml } from "../rx-renewal/renderers";

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
    // Built from the SAME renderer the fallback path uses, with `{{...}}`
    // placeholders in the value slots — byte parity by construction.
    bodyHtml: rxRenewalBrandedHtml({
      brandName: "{{brand_legal_name_html}}",
      greetingHtml: "{{greeting_html}}",
      headlineHtml: "{{headline_html}}",
      preheader: "{{headline}}",
      copyrightYear: "{{copyright_year}}",
    }),
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
      "copyright_year",
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
    bodyHtml: backInStockBrandedHtml({
      brandName: "{{brand_name_html}}",
      productName: "{{product_name_html}}",
      productUrl: "{{product_url_html}}",
      imageBlockHtml: "{{image_block_html}}",
      priceBlockHtml: "{{price_block_html}}",
      copyrightYear: "{{copyright_year}}",
    }),
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
      "copyright_year",
    ],
  },
  {
    templateKey: "appointment.assigned.email",
    channel: "email",
    subject: "An appointment was scheduled for you",
    bodyText:
      "Hi {{assignee_name}},\n\nAn appointment has been scheduled for you on the company calendar.\n\nType: {{appointment_type}}\nWhen: {{appointment_date}}, {{appointment_time}}\n{{location_line_text}}{{assigned_by_line_text}}\nView it in your dashboard: {{dashboard_url}}\n\n— {{brand_name}}",
    bodyHtml: appointmentAssignedBrandedHtml({
      brandName: "{{brand_name_html}}",
      greetingName: "{{assignee_name_html}}",
      typeHtml: "{{appointment_type_html}}",
      whenHtml: "{{when_html}}",
      preheaderType: "{{appointment_type}}",
      preheaderWhen: "{{when_plain}}",
      locationRowHtml: "{{location_row_html}}",
      assignedByRowHtml: "{{assigned_by_row_html}}",
      dashboardUrl: "{{dashboard_url_html}}",
      copyrightYear: "{{copyright_year}}",
    }),
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
      "when_plain",
      "copyright_year",
    ],
  },
];
