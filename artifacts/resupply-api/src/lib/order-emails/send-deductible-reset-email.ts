// sendDeductibleResetEmail — late-fall "stock up before Jan 1" push.
//
// Why
// ---
// US insurance deductibles and out-of-pocket maxes reset on January 1
// for the vast majority of plans. Patients who hit their deductible
// pay $0 out-of-pocket for in-network supplies through year-end, but
// drop back to full coinsurance / deductible the moment the calendar
// flips. A November "stock up now while you're still in-network and
// the deductible is satisfied" reminder is industry standard for
// any DME supplier and a meaningful Q4 revenue lever.
//
// This is marketing under CAN-SPAM (it's promoting a transaction
// the patient hasn't asked for yet). The dispatcher checks
// communication_preferences.emailMarketing before calling this
// helper, and the email itself carries an unsubscribe link to
// /account#comm-prefs.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  bulletList,
  escapeHtml,
  infoPanel,
  paragraph,
  renderBrandedEmail,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface SendDeductibleResetEmailInput {
  toEmail: string;
  firstName?: string | null;
  baseUrlOverride?: string;
  /**
   * Tenant the customer belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendDeductibleResetEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

export async function sendDeductibleResetEmail(
  input: SendDeductibleResetEmailInput,
): Promise<SendDeductibleResetEmailResult> {
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

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const contactUrl = `${base}/contact`;
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = "Use your benefits before January 1";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    "Your insurance deductible and out-of-pocket max reset on January 1.",
    "If you've already hit them this year, supplies you order before",
    "the calendar flips are likely $0 out-of-pocket — and full price",
    "in January.",
    "",
    "Common stock-up list:",
    "  • Replacement cushion or full mask",
    "  • Hose (annual replacement under most plans)",
    "  • Filters (every 1-3 months)",
    "",
    "Reply or call and we'll confirm coverage before the year flips:",
    contactUrl,
    "",
    `—The ${brandName} team`,
    "",
    `Unsubscribe from year-end reminders: ${prefsUrl}`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    heading: "Use your benefits before January 1",
    preheader: "Your deductible resets when the calendar flips.",
    contentHtml: [
      paragraph(greeting),
      paragraph(
        "Your insurance deductible and out-of-pocket max reset on January&nbsp;1. If you&#39;ve already hit them this year, supplies you order before the calendar flips are likely <strong>$0 out-of-pocket</strong> — and full price in January.",
      ),
      infoPanel({
        title: "Common stock-up list",
        html: bulletList([
          "Replacement cushion or full mask",
          "Hose (annual replacement under most plans)",
          "Filters (every 1-3 months)",
        ]),
      }),
    ].join("\n"),
    button: { label: "Contact us to stock up", url: contactUrl },
    footerHtml: `<a href="${escapeHtml(prefsUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Unsubscribe from year-end reminders</a>`,
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject,
      text,
      html,
      customArgs: { kind: "deductible_reset" },
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
