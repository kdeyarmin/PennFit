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

import { type SendgridClient } from "@workspace/resupply-email";

import { isFeatureEnabled } from "../feature-flags";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";

export type ReviewRequestEmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

export interface ReviewRequestEmailInput {
  to: string;
  productName: string;
  /** Absolute URL to /shop/p/:id with ?review=1 anchor. */
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
  if (!(await isFeatureEnabled("storefront.reviews_collection"))) {
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
  // this resolves to "PennPaps" (its stored brand), so single-tenant copy
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
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#0a1f44;background:#f8fafc;padding:24px;">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <tr><td>
      <h1 style="font-size:20px;margin:0 0 12px 0;">How are your supplies working out?</h1>
      <p style="line-height:1.5;margin:0 0 16px 0;">
        It's been a couple of weeks since you ordered ${escape(input.productName)} from ${escape(input.practice)}.
        If you have a minute, we'd love to hear how it's going. A short review helps other patients pick the right mask, cushion, or bundle the first time.
      </p>
      <p style="margin:24px 0;">
        <a href="${escape(input.productUrl)}" style="display:inline-block;background:#0a1f44;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:24px;font-weight:600;">
          Leave a review
        </a>
      </p>
      <p style="font-size:12px;color:#6b7280;line-height:1.5;margin:24px 0 0 0;">
        Not satisfied? Our 60-day comfort guarantee may apply to your order — reply to this email with your order number and we'll help you with a return or exchange.
      </p>
      <p style="font-size:11px;color:#9ca3af;margin:24px 0 0 0;">
        You can stop these emails anytime from your account &rsaquo; Communication preferences.
      </p>
    </td></tr>
  </table>
</body></html>`;
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

function escape(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
