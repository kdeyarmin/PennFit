// sendTherapyMilestoneEmail — celebration email for a CPAP-adherence
// milestone (100 nights, first-year, first-30-day adherence window).
//
// Why a dedicated helper
// ----------------------
// Three reasons it doesn't go through the generic message-template
// renderer:
//   1. The copy is celebratory and bespoke per milestone — the same
//      template for "100 nights" and "1 year" would feel canned.
//   2. The send needs to fail-open on missing SendGrid config; the
//      generic renderer assumes a configured channel.
//   3. We want the worker to remain free of @workspace/resupply-templates
//      since the per-milestone copy is small enough to inline cleanly.
//
// Fired from the therapy-milestones cron after the milestone row is
// inserted but before its notified_at is stamped — the same atomic-
// claim pattern used by the shipping notification.

import {
  EmailApiError,
  EmailConfigError,
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

export type MilestoneKind =
  | "100_nights"
  | "365_nights"
  | "first_adherence_month";

export interface SendTherapyMilestoneEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: MilestoneKind;
  /**
   * Optional metric snapshot for the body copy.
   *   100_nights / 365_nights → `totalNights`
   *   first_adherence_month  → `adherencePct`
   */
  metrics?: {
    totalNights?: number;
    adherencePct?: number;
  };
  baseUrlOverride?: string;
  /**
   * Tenant the patient belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendTherapyMilestoneEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

interface Copy {
  subject: string;
  headline: string;
  body: string;
}

function copyFor(
  kind: MilestoneKind,
  metrics: SendTherapyMilestoneEmailInput["metrics"],
): Copy {
  if (kind === "100_nights") {
    return {
      subject: "100 nights on therapy — congratulations",
      headline: "100 nights and counting",
      body:
        "You just hit 100 nights of CPAP therapy. That's a real milestone — the early weeks are the hardest, and you stuck with it. " +
        "Your sleep quality, oxygen levels, and heart all thank you.",
    };
  }
  if (kind === "365_nights") {
    return {
      subject: "One year of CPAP therapy",
      headline: "One year on therapy",
      body:
        "A full year of CPAP therapy — that's a huge achievement. " +
        "Most patients who hit a year stay with therapy for life, and the cardiovascular benefits compound. " +
        "We're glad we've been part of the ride.",
    };
  }
  // first_adherence_month
  const pct = metrics?.adherencePct;
  return {
    subject: "You hit Medicare's adherence target",
    headline: "Adherence target reached",
    body:
      "Your last 30 nights show " +
      (pct != null ? `${pct}% of nights` : "more than 70% of nights") +
      " over 4 hours of use — that's the Medicare adherence target. " +
      "Most patients never reach it. You did. Keep going.",
  };
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

export async function sendTherapyMilestoneEmail(
  input: SendTherapyMilestoneEmailInput,
): Promise<SendTherapyMilestoneEmailResult> {
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

  const c = copyFor(input.kind, input.metrics);
  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const therapyUrl = `${base}/account#therapy`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    c.body,
    "",
    `See your therapy summary: ${therapyUrl}`,
    "",
    "Sleep well,",
    `The ${brandName} team`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Milestone",
    heading: c.headline,
    preheader: c.body,
    contentHtml: [paragraph(greeting), textParagraph(c.body)].join("\n"),
    button: { label: "See your therapy summary", url: therapyUrl },
    footerLines: [`Sleep well, the ${brandName} team`],
    copyrightName: brandName,
  });

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject: c.subject,
      text,
      html,
      customArgs: {
        kind: "therapy_milestone",
        milestone: input.kind,
      },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: err.message,
      };
    }
    throw err;
  }
}
