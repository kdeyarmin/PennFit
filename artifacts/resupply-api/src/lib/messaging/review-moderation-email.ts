// Approve / reject moderation emails for customer-submitted product
// reviews on the cash-pay shop.
//
// Why this lives in messaging/ (not next to routes/admin/shop-reviews.ts):
//   * Other shop emails (cart abandonment, order receipts, reminder
//     nudges) all live under artifacts/resupply-api/src/lib/. Keeping
//     this here makes "find every place we send mail" trivial via
//     `rg "createSendgridClient" artifacts/resupply-api/src/lib`.
//   * The handler stays a route handler — it shouldn't know about
//     SendGrid config or template rendering.
//
// Fail-soft contract:
//   The exported helpers NEVER throw. They return a discriminated
//   `{sent: true, messageId}` or `{sent: false, reason}` shape so
//   the moderation route can log `req.log.warn(reason)` and keep
//   serving 200 even when SENDGRID_API_KEY is missing in dev or
//   SendGrid is down. Approving/rejecting a review must NEVER block
//   on email infrastructure — admins were promised the moderation
//   queue stays usable regardless of mail status.
//
// Templates:
//   Plain HTML (no MJML / no template engine — keeps the dependency
//   surface tiny). Tone matches the existing reminder/cart-abandonment
//   templates: short, on-brand, one CTA. Both include a plain-text
//   fallback because corporate spam filters routinely drop HTML-only
//   mail.
//
// What we DO NOT include in either template:
//   - The full review body, never. The email is a notification, not
//     a forwarded copy of the content.
//   - Any internal moderation metadata (reviewer id, admin email).

import {
  createSendgridClient,
  EmailConfigError,
  type SendgridClient,
} from "@workspace/resupply-email";

import { readPracticeName } from "./messaging-config";

export type ModerationEmailResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: string };

/**
 * Optional dependency injection for unit tests. The route handler
 * always calls without args — production reads env vars off the
 * shared `createSendgridClient` factory.
 */
export interface SendModerationEmailDeps {
  /**
   * Build / look up the SendGrid client. Returning `null` from the
   * factory is the documented "config absent" path → emits
   * `{sent:false, reason:'email_not_configured'}`.
   */
  clientFactory?: () => SendgridClient | null;
}

function defaultClientFactory(): SendgridClient | null {
  try {
    return createSendgridClient();
  } catch (err) {
    // EmailConfigError is the well-defined "no SENDGRID_API_KEY in
    // env" path. Anything else here is genuinely unexpected — the
    // factory does almost nothing besides reading env vars — but we
    // still trap it so `try { client = factory() } catch {}` isn't
    // needed at every call site.
    if (err instanceof EmailConfigError) return null;
    return null;
  }
}

export interface ApprovedEmailInput {
  to: string;
  /** Display name of the product the review is about. */
  productName: string;
  /** Browser URL of the product page (absolute, includes scheme). */
  productUrl: string;
}

export interface RejectedEmailInput {
  to: string;
  productName: string;
  /** Optional moderator note. When omitted, a generic message is shown. */
  moderationNote: string | null;
  /** Where the customer can edit + resubmit. Absolute URL. */
  editUrl: string;
}

export async function sendReviewApprovedEmail(
  input: ApprovedEmailInput,
  deps: SendModerationEmailDeps = {},
): Promise<ModerationEmailResult> {
  const client = (deps.clientFactory ?? defaultClientFactory)();
  if (!client) {
    return { sent: false, reason: "email_not_configured" };
  }
  const practiceName = readPracticeName();
  const subject = `Your ${practiceName} review is live`;
  const safeProductName = escapeHtml(input.productName);
  const safeProductUrl = encodeURI(input.productUrl);

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
      <h1 style="font-size: 20px; margin: 0 0 12px; color: #1f3360;">Your review is live</h1>
      <p style="font-size: 15px; line-height: 1.55; margin: 0 0 16px;">
        Thanks for sharing your experience with <strong>${safeProductName}</strong>.
        It&rsquo;s now visible to other ${escapeHtml(practiceName)} shoppers — your
        feedback helps people pick the right gear.
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${safeProductUrl}" style="display: inline-block; background: #1f3360; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">View your review</a>
      </p>
      <p style="font-size: 12px; color: #6b7280; margin: 0;">
        Sent by ${escapeHtml(practiceName)} because you wrote a product review on our shop.
        If something looks off, just reply to this email.
      </p>
    </div>
  `.trim();

  const text = [
    `Your ${practiceName} review is live`,
    "",
    `Thanks for sharing your experience with ${input.productName}. ` +
      `It's now visible to other ${practiceName} shoppers.`,
    "",
    `View it here: ${input.productUrl}`,
  ].join("\n");

  return await safeSend(client, {
    to: input.to,
    subject,
    html,
    text,
  });
}

export async function sendReviewRejectedEmail(
  input: RejectedEmailInput,
  deps: SendModerationEmailDeps = {},
): Promise<ModerationEmailResult> {
  const client = (deps.clientFactory ?? defaultClientFactory)();
  if (!client) {
    return { sent: false, reason: "email_not_configured" };
  }
  const practiceName = readPracticeName();
  const safeProductName = escapeHtml(input.productName);
  const safeEditUrl = encodeURI(input.editUrl);
  const subject = `An update on your ${practiceName} review`;

  // Generic copy when the moderator left no note — tells the customer
  // what to look at without being specific (and without leaking the
  // moderator's internal triage shorthand).
  const moderatorBlock = input.moderationNote
    ? `<p style="background: #fff5f0; border-left: 3px solid #d97706; padding: 12px 14px; margin: 0 0 18px; font-size: 14px; line-height: 1.5;">
         <strong>Moderator note:</strong> ${escapeHtml(input.moderationNote)}
       </p>`
    : `<p style="background: #f4f6fb; border-left: 3px solid #1f3360; padding: 12px 14px; margin: 0 0 18px; font-size: 14px; line-height: 1.5;">
         Reviews need to be specifically about the product itself —
         shipping, ordering, or insurance issues are best handled
         directly by our team.
       </p>`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #111;">
      <h1 style="font-size: 20px; margin: 0 0 12px; color: #1f3360;">An update on your review</h1>
      <p style="font-size: 15px; line-height: 1.55; margin: 0 0 16px;">
        Thanks for taking the time to review <strong>${safeProductName}</strong>.
        Before it can go live we&rsquo;d like a small revision.
      </p>
      ${moderatorBlock}
      <p style="margin: 0 0 24px;">
        <a href="${safeEditUrl}" style="display: inline-block; background: #1f3360; color: #fff; padding: 10px 18px; border-radius: 8px; text-decoration: none; font-weight: 600;">Edit and resubmit</a>
      </p>
      <p style="font-size: 12px; color: #6b7280; margin: 0;">
        Sent by ${escapeHtml(practiceName)}. Replying to this email reaches our
        team directly.
      </p>
    </div>
  `.trim();

  const textNote = input.moderationNote
    ? `Moderator note: ${input.moderationNote}\n\n`
    : "Reviews need to be specifically about the product itself — shipping or " +
      "ordering issues are best handled directly by our team.\n\n";

  const text = [
    `An update on your ${practiceName} review`,
    "",
    `Thanks for taking the time to review ${input.productName}. ` +
      `Before it can go live we'd like a small revision.`,
    "",
    textNote.trimEnd(),
    "",
    `Edit and resubmit: ${input.editUrl}`,
  ].join("\n");

  return await safeSend(client, {
    to: input.to,
    subject,
    html,
    text,
  });
}

async function safeSend(
  client: SendgridClient,
  msg: { to: string; subject: string; html: string; text: string },
): Promise<ModerationEmailResult> {
  try {
    const { messageId } = await client.sendEmail(msg);
    return { sent: true, messageId };
  } catch (err) {
    return {
      sent: false,
      reason:
        err instanceof Error ? err.message : "sendgrid_unknown_failure",
    };
  }
}

/**
 * Minimal HTML escape so a product name like `Mask "X" & co.` can't
 * inject markup into the rendered email body. Defense in depth — the
 * source of these strings is the Stripe catalog (and the moderator
 * note, which is admin-controlled), but treating them as untrusted is
 * the safer default.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
