// sendWinbackEmail — soft "we miss you" outreach for customers who
// haven't ordered in 6+ months.
//
// Why
// ---
// Customers who lapse for half a year are a low-cost reactivation
// target — they already know the brand, already have an account
// with a saved address (and often card), and the next purchase
// requires only a click. A tasteful win-back with a small
// re-engagement nudge ("here's what's new") recovers a
// double-digit percentage of lapsed customers in DME industry
// benchmarks.
//
// This is marketing under CAN-SPAM. The dispatcher checks
// communication_preferences.emailMarketing before calling and
// the email itself carries an unsubscribe link.
//
// Idempotency happens at the dispatcher level via the
// shop_customers.winback_sent_at column — we never send more than
// one win-back per customer per 12 months.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  secondaryLink,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

export interface SendWinbackEmailInput {
  toEmail: string;
  firstName?: string | null;
  /**
   * Approximate months since the customer's last order. Used only in
   * copy — "it's been about 8 months since we last shipped to you."
   */
  monthsSinceLastOrder: number;
  baseUrlOverride?: string;
  /**
   * Tenant the customer belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendWinbackEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

export async function sendWinbackEmail(
  input: SendWinbackEmailInput,
): Promise<SendWinbackEmailResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const base = await resolvePatientEmailLinkBase(
    input.orgId,
    input.baseUrlOverride,
  );
  if (!base) {
    return {
      configured: true,
      delivered: false,
      error: TENANT_DOMAIN_REQUIRED,
    };
  }
  const contactUrl = `${base}/contact`;
  const insuranceUrl = `${base}/insurance`;
  const accountUrl = `${base}/account`;
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = "It's been a while — quick CPAP check-in";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    `It's been about ${input.monthsSinceLastOrder} months since we last shipped to you,`,
    "and we wanted to check in. CPAP supplies have replacement cadences for a",
    "reason — cushions stiffen, filters clog, hoses develop holes — and skipping",
    "replacement is the single biggest reason therapy slips.",
    "",
    "If you've stopped CPAP therapy, no judgment — we'd just love to know.",
    "If you've moved to a different supplier, also fine. If you've stayed on",
    "therapy but your supplies are due, reply or call and we'll confirm",
    "coverage and schedule a shipment through insurance:",
    "",
    `Contact us: ${contactUrl}`,
    `How insurance works: ${insuranceUrl}`,
    `Account: ${accountUrl}`,
    "",
    `—The ${brandName} team`,
    "",
    `Unsubscribe from re-engagement emails: ${prefsUrl}`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Quick CPAP check-in",
    heading: "It's been a while",
    preheader: `It's been about ${input.monthsSinceLastOrder} months since we last shipped to you.`,
    contentHtml: [
      paragraph(greeting),
      paragraph(
        `It&#39;s been about <strong>${input.monthsSinceLastOrder} months</strong> since we last shipped to you, and we wanted to check in. CPAP supplies have replacement cadences for a reason — cushions stiffen, filters clog, hoses develop holes — and skipping replacement is the single biggest reason therapy slips.`,
      ),
      paragraph(
        "If you&#39;ve stopped CPAP therapy, no judgment. If you&#39;ve moved to a different supplier, also fine. If you&#39;ve stayed on therapy but your supplies are due, reply or call and we&#39;ll confirm coverage and schedule a shipment through insurance.",
      ),
    ].join("\n"),
    button: { label: "Contact us to resupply", url: contactUrl },
    postButtonHtml: secondaryLink("How insurance works", insuranceUrl),
    footerHtml: `<a href="${escapeHtml(prefsUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Unsubscribe from re-engagement emails</a>`,
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject,
      text,
      html,
      customArgs: { kind: "lapsed_customer_winback" },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return { configured: true, delivered: false, error: err.message };
    }
    throw err;
  }
}
