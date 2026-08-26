// Post-purchase review-request email.
//
// Sent ~14 days after delivery (or paidAt as a proxy) on a single-shot
// basis per order. Customers who toggled `emailReviewRequests=false`
// in /account → Communication preferences are excluded by the
// dispatcher BEFORE this helper is invoked; the helper itself only
// concerns itself with rendering + sending.
//
// Fail-soft contract matches the rest of messaging/: never throws,
// returns a discriminated `{sent, reason?}` shape so the dispatcher
// keeps moving on partial failures.

import {
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  type SendgridClient,
} from "@workspace/resupply-email";

import { isFeatureEnabled } from "../feature-flags";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";

export type ReviewRequestEmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

export interface ReviewRequestEmailInput {
  to: string;
  productName: string;
  /** Absolute URL for the review CTA (contact / living surface — cash-pay product pages are gone). */
  productUrl: string;
  /**
   * Tenant the order belongs to. When set, the email is sent under the
   * tenant's own From identity (G6) and branded with the tenant's
   * storefront name; omit / undefined keeps the platform default.
   */
  orgId?: string;
}

export interface SendReviewRequestEmailDeps {
  clientFactory?: () => SendgridClient | null;
}

export async function sendReviewRequestEmail(
  input: ReviewRequestEmailInput,
  deps: SendReviewRequestEmailDeps = {},
): Promise<ReviewRequestEmailResult> {
  // Control Center feature gate. Returns the same shape as the
  // SendGrid-not-configured branch so the dispatcher's counters
  // (sent / skipped) flow uninterrupted.
  if (!(await isFeatureEnabled("storefront.reviews_collection", input.orgId))) {
    return { sent: false, reason: "feature_disabled" };
  }

  // Tests inject a synchronous clientFactory; honour that seam unchanged.
  // Otherwise build a SendgridClient bound to the tenant's own From
  // identity (G6) — falling back to the platform default when the tenant
  // has none / orgId is unset.
  let client: SendgridClient | null;
  if (deps.clientFactory) {
    client = deps.clientFactory();
  } else {
    try {
      client = await createTenantSendgridClient(input.orgId);
    } catch {
      // Fail soft: any config/build failure (incl. EmailConfigError) skips
      // cleanly as "not configured" rather than throwing out of this helper.
      client = null;
    }
  }
  if (!client) return { sent: false, reason: "email_not_configured" };

  // Brand with the tenant's own storefront name (G6). For the seed tenant
  // this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant copy
  // is unchanged.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const practice = brand.storefrontName;
  const subject = `How is your ${input.productName}?`;
  const html = renderHtml({ practice, ...input });
  const text = renderText({ practice, ...input });

  try {
    const { messageId } = await client.sendEmail({
      to: input.to,
      subject,
      html,
      text,
    });
    return { sent: true, messageId };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "send_failed",
    };
  }
}

function renderHtml(input: {
  practice: string;
  productName: string;
  productUrl: string;
}): string {
  // Chrome comes from the shared CareMetric Breathe email design system.
  return renderBrandedEmail({
    brandName: input.practice,
    heading: "How are your supplies working out?",
    preheader: `It's been a couple of weeks since you ordered ${input.productName}.`,
    contentHtml: [
      paragraph(
        `It&#39;s been a couple of weeks since you ordered ${escapeHtml(
          input.productName,
        )} from ${escapeHtml(
          input.practice,
        )}. If you have a minute, we&#39;d love to hear how it&#39;s going. A short review helps other patients pick the right mask, cushion, or bundle the first time.`,
      ),
    ].join("\n"),
    button: { label: "Leave a review", url: input.productUrl },
    footerLines: [
      "Not satisfied? Our 60-day comfort guarantee may apply to your order — reply to this email with your order number and we'll help you with a return or exchange.",
      "You can stop these emails anytime from your account › Communication preferences.",
    ],
    copyrightName: input.practice,
  });
}

function renderText(input: {
  practice: string;
  productName: string;
  productUrl: string;
}): string {
  return [
    `How are your supplies working out?`,
    "",
    `It's been a couple of weeks since you ordered ${input.productName} from ${input.practice}.`,
    `If you have a minute, we'd love to hear how it's going.`,
    "",
    `Leave a review: ${input.productUrl}`,
    "",
    `Not satisfied? Our 60-day comfort guarantee may apply to your order —`,
    `reply to this email with your order number and we'll help you with a return or exchange.`,
    "",
    `You can stop these emails anytime from your account → Communication preferences.`,
  ].join("\n");
}
