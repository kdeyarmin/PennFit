// sendLifecycleTouchpointEmail — once-yearly birthday + sleep-
// therapy anniversary celebration email.
//
// Why a dedicated helper
// ----------------------
// Birthday + anniversary touchpoints have outsized open rates in
// adherence-coaching research, but only if the copy is warm and
// brand-aligned — a generic "we noticed it's your birthday" template
// drops open rates by half. Two short, hand-tuned variants beat one
// merge field every time.
//
// Marketing posture
// -----------------
// Gated upstream by communication_preferences.emailMarketing. The
// email itself includes a footer unsubscribe link. We deliberately
// keep the body soft — no upsell, no discount code, no resupply
// reminder. The point is the relationship signal, not the next sale.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export type LifecycleKind = "birthday" | "sleep_anniversary";

export interface SendLifecycleTouchpointEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: LifecycleKind;
  /**
   * For "sleep_anniversary" the worker knows how many years they've
   * been on therapy; we surface "X years of CPAP" in the headline.
   * Ignored for "birthday".
   */
  yearsOnTherapy?: number;
  baseUrlOverride?: string;
  /**
   * Tenant the patient belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendLifecycleTouchpointEmailResult {
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

interface Copy {
  subject: string;
  headline: string;
  body: string;
}

function copyFor(
  kind: LifecycleKind,
  yearsOnTherapy: number | undefined,
  brandName: string,
): Copy {
  if (kind === "birthday") {
    return {
      subject: `Happy birthday from ${brandName}`,
      headline: "Happy birthday",
      body:
        "From the team that takes care of your sleep supplies — happy birthday. " +
        "Cardiovascular health, mental clarity, energy through the day — every one of " +
        "those starts with a good night's sleep, and you've been showing up for that. " +
        "Here's to another year of feeling rested.",
    };
  }
  const yearsLabel =
    yearsOnTherapy && yearsOnTherapy > 0
      ? yearsOnTherapy === 1
        ? "1 year"
        : `${yearsOnTherapy} years`
      : "another year";
  return {
    subject: `Anniversary: ${yearsLabel} of CPAP therapy`,
    headline: `${yearsLabel} on therapy`,
    body:
      `Today marks ${yearsLabel} since your first night on CPAP therapy with us. ` +
      "Most patients who stay with therapy past the first year stay with it for life — " +
      "and the long-term cardiovascular and cognitive benefits compound. " +
      "We're glad we've been part of the ride.",
  };
}

export async function sendLifecycleTouchpointEmail(
  input: SendLifecycleTouchpointEmailInput,
): Promise<SendLifecycleTouchpointEmailResult> {
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

  const c = copyFor(input.kind, input.yearsOnTherapy, brandName);
  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    c.body,
    "",
    `—The ${brandName} team`,
    "",
    `Manage these emails: ${prefsUrl}`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: input.kind === "birthday" ? "Birthday" : "Anniversary",
    heading: c.headline,
    preheader: c.body,
    contentHtml: [paragraph(greeting), textParagraph(c.body)].join("\n"),
    footerHtml: `<a href="${escapeHtml(prefsUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Manage these emails</a>`,
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject: c.subject,
      text,
      html,
      customArgs: { kind: `lifecycle_${input.kind}` },
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
