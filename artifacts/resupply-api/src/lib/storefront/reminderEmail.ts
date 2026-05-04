/**
 * Reminder email delivery for PennPaps supply replacement reminders.
 *
 * Three flavors:
 *   - sendReminderConfirmation — sent immediately after a customer subscribes,
 *     so they have a manage link they can use to update or unsubscribe.
 *   - sendReminderManageLink — sent when an existing email re-submits the
 *     subscribe form. Contains the EXISTING manage link so the registered
 *     owner can update — but the unauthenticated submitter never sees it.
 *     This closes a token-disclosure hole on the subscribe endpoint.
 *   - sendReminderDue — sent by the dispatcher when one or more of a
 *     subscriber's items has reached its replacement interval.
 *
 * Configuration (all REQUIRED for actual delivery — read by the shared
 * `createSendgridClient()` from @workspace/resupply-email):
 *   - SENDGRID_API_KEY     — SendGrid API key with "Mail Send" permission
 *   - SENDGRID_FROM_EMAIL  — Verified sender on the SendGrid account
 *                            (operations should set this to info@pennpaps.com
 *                            so every outbound email originates from the
 *                            canonical practice address)
 *   - SENDGRID_FROM_NAME   — Display name shown next to the From address
 *
 * Optional:
 *   - REMINDER_PUBLIC_BASE_URL — Base URL for manage / unsubscribe links.
 *     Defaults to https://pennpaps.com so links emitted from preview /
 *     staging deploys still resolve to production.
 *
 * If SendGrid isn't configured, the functions return
 * { configured: false, delivered: false } and the caller persists
 * "skipped" — we never throw on missing config and we never silently
 * swallow an error.
 *
 * Privacy: we deliberately log only the SKU of items in error paths;
 * the recipient email is never logged.
 */

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export interface SendEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
}

export interface ReminderItemForEmail {
  sku: string;
  lastReplacedAt: string;
  intervalDays: number;
  nextDueAt: string;
}

const SKU_LABELS: Record<string, string> = {
  maskCushion: "Mask cushion / nasal pillows",
  maskFrameHeadgear: "Mask frame & headgear clips",
  headgear: "Headgear straps",
  tubing: "CPAP tubing",
  disposableFilter: "Disposable filters",
  reusableFilter: "Reusable filters",
  waterChamber: "Humidifier water chamber",
};

export function labelForSku(sku: string): string {
  return SKU_LABELS[sku] ?? sku;
}

export function manageLinkFor(token: string): string {
  const base = (
    process.env.REMINDER_PUBLIC_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/$/, "");
  return `${base}/reminders/manage?token=${encodeURIComponent(token)}`;
}

function formatItemsList(items: ReminderItemForEmail[]): string {
  return items
    .map(
      (i) =>
        `  • ${labelForSku(i.sku)} — every ${i.intervalDays} days (next due ${i.nextDueAt})`,
    )
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert the plain-text body to a minimally-styled HTML body. We keep
 * the same content verbatim so the two views never drift; corporate
 * spam filters that drop HTML-only mail will still see the text part.
 */
function bodyToHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;white-space:pre-wrap;font-size:15px;line-height:1.5;color:#222">${escapeHtml(text)}</div>`;
}

/**
 * Send via the shared SendGrid integration. All Penn Fit reminder emails
 * funnel through this single helper so the From address (info@pennpaps.com),
 * display name, and API key are always read from the same env vars as the
 * rest of the platform — no separate PENN_FROM_EMAIL, no raw fetch.
 */
async function sendViaSendGrid(opts: {
  toEmail: string;
  subject: string;
  body: string;
}): Promise<SendEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false };
    }
    return {
      configured: false,
      delivered: false,
      error: err instanceof Error ? err.message : "Unknown email config error",
    };
  }

  try {
    await client.sendEmail({
      to: opts.toEmail,
      subject: opts.subject,
      text: opts.body,
      html: bodyToHtml(opts.body),
    });
    return { configured: true, delivered: true };
  } catch (err) {
    if (err instanceof EmailApiError) {
      const status = err.status ?? "unknown";
      return {
        configured: true,
        delivered: false,
        error: `Email provider returned ${status}: ${err.message.slice(0, 200)}`,
      };
    }
    return {
      configured: true,
      delivered: false,
      error:
        err instanceof Error ? err.message : "Unknown email delivery error",
    };
  }
}

/**
 * Sent right after a customer subscribes (or re-subscribes / reactivates).
 * Confirms what they signed up for and gives them the manage link.
 */
export async function sendReminderConfirmation(opts: {
  toEmail: string;
  manageToken: string;
  items: ReminderItemForEmail[];
}): Promise<SendEmailResult> {
  const link = manageLinkFor(opts.manageToken);
  const lines: string[] = [];
  lines.push("You're signed up for PennPaps supply reminders.");
  lines.push("");
  lines.push("We'll email you when each of these items is due to be replaced:");
  lines.push("");
  lines.push(formatItemsList(opts.items));
  lines.push("");
  lines.push("Need to change your dates, intervals, or unsubscribe?");
  lines.push(link);
  lines.push("");
  lines.push("— PennPaps by Penn Home Medical Supply");

  return sendViaSendGrid({
    toEmail: opts.toEmail,
    subject: "You're signed up for PennPaps supply reminders",
    body: lines.join("\n"),
  });
}

/**
 * Sent when an existing email re-submits the public subscribe form.
 * The submitter never sees the manage token in the API response (we
 * deliberately omit it to prevent email-enumeration takeover); instead,
 * we deliver the existing manage link only to the registered owner's
 * inbox. If the submitter IS the owner, they get the link as expected;
 * if they're not, they get nothing useful.
 */
export async function sendReminderManageLink(opts: {
  toEmail: string;
  manageToken: string;
}): Promise<SendEmailResult> {
  const link = manageLinkFor(opts.manageToken);
  const lines: string[] = [];
  lines.push(
    "Someone — possibly you — re-submitted the PennPaps reminder signup form",
  );
  lines.push("with this email address.");
  lines.push("");
  lines.push(
    "You're already subscribed. To update the supplies you want reminders for,",
  );
  lines.push("change replacement dates, or unsubscribe, use your manage link:");
  lines.push("");
  lines.push(link);
  lines.push("");
  lines.push(
    "If this wasn't you, no action is needed — your subscription is unchanged.",
  );
  lines.push("");
  lines.push("— PennPaps by Penn Home Medical Supply");

  return sendViaSendGrid({
    toEmail: opts.toEmail,
    subject: "Your PennPaps reminders manage link",
    body: lines.join("\n"),
  });
}

/**
 * Sent by the dispatcher when one or more of a subscriber's items has
 * become due. `dueItems` is a non-empty list of items past their
 * `nextDueAt` date.
 */
export async function sendReminderDue(opts: {
  toEmail: string;
  manageToken: string;
  dueItems: ReminderItemForEmail[];
}): Promise<SendEmailResult> {
  const link = manageLinkFor(opts.manageToken);
  const isPlural = opts.dueItems.length > 1;
  const lines: string[] = [];
  lines.push(`Time to replace your CPAP ${isPlural ? "supplies" : "supply"}.`);
  lines.push("");
  lines.push(
    isPlural
      ? "These items are due based on your replacement schedule:"
      : "This item is due based on your replacement schedule:",
  );
  lines.push("");
  lines.push(formatItemsList(opts.dueItems));
  lines.push("");
  lines.push(
    "Need a refill? Visit the PennPaps shop to order — or call Penn Home Medical Supply.",
  );
  lines.push("");
  lines.push(
    "Already replaced these on your own? Update your dates here so we don't",
  );
  lines.push("nag you again:");
  lines.push(link);
  lines.push("");
  lines.push("— PennPaps by Penn Home Medical Supply");

  return sendViaSendGrid({
    toEmail: opts.toEmail,
    subject: isPlural
      ? "Your CPAP supplies are due for replacement"
      : `Your ${labelForSku(opts.dueItems[0]!.sku).toLowerCase()} is due for replacement`,
    body: lines.join("\n"),
  });
}
