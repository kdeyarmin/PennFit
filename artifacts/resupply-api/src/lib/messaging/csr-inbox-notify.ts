// CSR-inbox notification — best-effort "a customer messaged us" email
// to the shared customer-service inbox.
//
// Extracted from routes/shop/me-messages.ts so BOTH callers can share
// one implementation:
//   * POST /shop/me/messages       — the customer typed a message in
//                                     the /account messages thread.
//   * The signed-in chatbot's      — PennBot filed a message on the
//     escalate_to_human tool          customer's behalf after they asked
//                                     to reach a human.
//
// The notification is deliberately content-free: subject + body carry
// only the customer's display name (or email) and a link to the admin
// thread. The message body itself is never emailed, so even though the
// in-app body is plaintext in the DB, the email provider never sees
// PHI.
//
// Skips silently when:
//   * `SHOP_CSR_INBOX_EMAIL` is unset (operator opt-out)
//   * `SENDGRID_API_KEY` etc. are unset (preview / dev)

import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

export interface NotifyCsrInboxInput {
  threadId: string;
  threadCreated: boolean;
  customerEmail: string | null;
  customerDisplayName: string | null;
  /**
   * Optional origin hint surfaced in the subject so a CSR can tell a
   * message the customer typed themselves from one PennBot filed on
   * their behalf. Defaults to a plain customer message.
   */
  source?: "customer" | "chatbot";
}

/**
 * Notify the shared CSR inbox that a customer message landed. Best-
 * effort — a SendGrid outage must not reach the caller (callers wrap
 * this in `.catch`). The notification is subject-only (no body) so the
 * email provider never sees PHI.
 */
export async function notifyCsrInboxOfCustomerMessage(
  input: NotifyCsrInboxInput,
): Promise<void> {
  const inboxEmail = process.env["SHOP_CSR_INBOX_EMAIL"]?.trim();
  if (!inboxEmail) {
    return;
  }

  let sg;
  try {
    sg = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Preview / dev — no SENDGRID_API_KEY. Skip silently.
      return;
    }
    throw err;
  }

  // Subject + body are deliberately content-free. We surface the
  // customer's display name (or email) so the CSR knows who pinged
  // — display name is already visible in the admin inbox header,
  // not new PHI surface.
  const customerLabel =
    input.customerDisplayName ?? input.customerEmail ?? "A shop customer";
  const viaPennBot = input.source === "chatbot" ? " (via PennBot)" : "";
  const subjectPrefix = input.threadCreated ? "New" : "Reply on";
  const subject = `${subjectPrefix} customer message${viaPennBot} — ${customerLabel}`;

  // Pull the public base URL from the same env the rest of the shop
  // side uses. Fallback to relative path so the link still navigates
  // if the env var isn't set in dev.
  const base = process.env["SHOP_PUBLIC_BASE_URL"]?.trim().replace(/\/$/, "");
  const inboxUrl = `${base ?? ""}/admin/conversations/${input.threadId}`;

  const intro =
    input.source === "chatbot"
      ? `PennBot filed a message for a signed-in shop customer who asked to reach a person.`
      : `A signed-in shop customer just messaged customer service.`;

  await sg.sendEmail({
    to: inboxEmail,
    subject,
    text:
      `${intro}\n\n` +
      `Open the thread:\n${inboxUrl}\n\n` +
      `(This email contains no message content. Sign in to read.)\n`,
    html:
      `<p>${intro}</p>` +
      `<p><a href="${inboxUrl}" style="color: #003B71">Open the thread →</a></p>` +
      `<p style="color: #6b7280; font-size: 12px">` +
      `This email contains no message content. Sign in to read.` +
      `</p>`,
    customArgs: {
      conversation_id: input.threadId,
      kind: "in_app_csr_inbox_ping",
    },
  });
}
