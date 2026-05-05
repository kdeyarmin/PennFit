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
  createSendgridClient,
  EmailConfigError,
  type SendgridClient,
} from "@workspace/resupply-email";

import { readPracticeName } from "./messaging-config";

export type ReviewRequestEmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

export interface ReviewRequestEmailInput {
  to: string;
  productName: string;
  /** Absolute URL to /shop/p/:id with ?review=1 anchor. */
  productUrl: string;
}

export interface SendReviewRequestEmailDeps {
  clientFactory?: () => SendgridClient | null;
}

function defaultClientFactory(): SendgridClient | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    return null;
  }
}

export async function sendReviewRequestEmail(
  input: ReviewRequestEmailInput,
  deps: SendReviewRequestEmailDeps = {},
): Promise<ReviewRequestEmailResult> {
  const factory = deps.clientFactory ?? defaultClientFactory;
  const client = factory();
  if (!client) return { sent: false, reason: "email_not_configured" };

  const practice = readPracticeName();
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
        Not loving it? You're inside our 60-day comfort guarantee — reply to this email and we'll send a different size or style with a free return label.
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
    `Not loving it? You're inside our 60-day comfort guarantee —`,
    `reply to this email and we'll send a different size or style with a free return label.`,
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
