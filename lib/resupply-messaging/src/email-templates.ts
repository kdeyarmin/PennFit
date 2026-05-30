// @workspace/resupply-messaging — email-body rendering.
//
// Pure string templating. We deliberately avoid handlebars/MJML/JSX —
// every template here is short and stable, and a string-template diff
// is the easiest thing for ops to review on a HIPAA-touching surface.
//
// Rules of the road:
//   - NEVER put PHI in the subject. Subject lines are not encrypted at
//     any provider and end up in many third-party inbox indexes.
//   - HTML is inline-styled because most webmail clients strip
//     `<style>` blocks.
//   - Every template includes a plain-text fallback. Many corporate
//     mail filters drop HTML-only mail, and the text version is what
//     screen readers read aloud.
//   - All interpolated strings pass through `escapeHtml` for the HTML
//     body — INCLUDING URLs that land in `href` attributes. The HTML
//     spec requires `&` inside an attribute value to be encoded as
//     `&amp;`, and browsers correctly decode it back when navigating,
//     so `?t=x&s=y` becomes `?t=x&amp;s=y` in the markup and `?t=x&s=y`
//     when followed. Callers are still responsible for passing
//     well-formed URLs in (we do not URL-encode query parameters here).
//   - Plain-text bodies are NOT HTML-escaped. Doing so would render
//     entity literals (`&amp;`) to recipients reading the text part.

export interface RenderResupplyReminderInput {
  /** Practice display name (e.g. "Penn Sleep Center"). Already admin-vetted. */
  practiceName: string;
  /** Patient's first name. PHI — render in the body, not the subject. */
  firstName: string;
  /** Items the order will ship. */
  items: ReadonlyArray<{ name: string; quantity: number }>;
  /** Signed link the "Confirm" CTA points at. */
  confirmUrl: string;
  /** Signed link the "Change address" CTA points at. */
  editUrl: string;
  /** Signed link the "Stop reminders" CTA points at. */
  stopUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Escape the five HTML-sensitive characters for safe embedding in element content and double-quoted attributes.
 *
 * Replaces `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, and `'` → `&#39;`.
 * This does not perform URL-encoding; pass already-well-formed URLs when escaping attribute values.
 *
 * Note: escaping prevents HTML injection but does not mitigate dangerous URI schemes (for example `javascript:` or `data:`).
 * Callers must validate or restrict URL schemes before using escaped values in `href`/`src` attributes.
 *
 * @param s - The input string to escape
 * @returns The input string with HTML-special characters replaced by their entity equivalents
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Coerce a caller-supplied URL into a safe `href` value. Only
 * absolute http(s) URLs survive; anything else (javascript:, data:,
 * vbscript:, mailto:, malformed) falls back to `"#"` which renders
 * as a no-op link. The returned value is HTML-escaped and ready to
 * drop into a `href="..."` attribute.
 *
 * Why this matters: `escapeHtml` HTML-entity-escapes the input but
 * does NOT mitigate dangerous URI schemes — a `javascript:fetch(...)`
 * string survives entity escaping intact and executes when the
 * recipient clicks it. URLs in reminder emails flow from
 * `publicBaseUrl` (admin-configured); a misconfigured prefix would
 * otherwise become an executable XSS payload in every email.
 */
export function safeHref(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "#";
    }
    return escapeHtml(parsed.toString());
  } catch {
    return "#";
  }
}

export function renderResupplyReminder(
  input: RenderResupplyReminderInput,
): RenderedEmail {
  const subject = "Time to refill your CPAP supplies";
  const safeFirstName = escapeHtml(input.firstName);
  const safePractice = escapeHtml(input.practiceName);
  const itemsTextLines = input.items
    .map((it) => `  • ${it.name} × ${it.quantity}`)
    .join("\n");
  const itemsHtmlLines = input.items
    .map(
      (it) =>
        `<li style="margin:4px 0;">${escapeHtml(it.name)} × ${it.quantity}</li>`,
    )
    .join("");

  const text = [
    `Hi ${input.firstName},`,
    "",
    `Quick note from ${input.practiceName} — you're due for a CPAP refill, and your next order is ready whenever you are:`,
    "",
    itemsTextLines || "  (your supplies, per your prescription)",
    "",
    "Pick one:",
    `  Yes, ship it: ${input.confirmUrl}`,
    `  Change my address: ${input.editUrl}`,
    `  Stop these reminders: ${input.stopUrl}`,
    "",
    "If a link doesn't work, just reply to this email — a real person reads it.",
    "",
    "Talk soon,",
    `the ${input.practiceName} team`,
  ].join("\n");

  // Inline-styled responsive HTML. No external CSS, no <style> block —
  // tested against Gmail, Outlook 365, Apple Mail. Keep the table-based
  // layout out (single-column flex via `<table>` is overkill for one CTA).
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:#0f172a;">
      Time to refill your CPAP supplies
    </h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:22px;">
      Hi ${safeFirstName} — quick note from ${safePractice}. You're due for a CPAP refill, and your next order is ready whenever you are:
    </p>
    <ul style="margin:0 0 24px;padding-left:18px;font-size:15px;line-height:22px;color:#1e293b;">
      ${itemsHtmlLines || `<li style="margin:4px 0;">Your supplies, per your prescription.</li>`}
    </ul>
    <div style="margin:0 0 24px;">
      <a href="${safeHref(input.confirmUrl)}" style="display:inline-block;padding:12px 20px;border-radius:6px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">
        Yes, ship it
      </a>
    </div>
    <p style="margin:0 0 8px;font-size:14px;line-height:20px;color:#475569;">
      <a href="${safeHref(input.editUrl)}" style="color:#0f766e;text-decoration:underline;">Change my shipping address</a>
    </p>
    <p style="margin:0 0 24px;font-size:14px;line-height:20px;color:#475569;">
      <a href="${safeHref(input.stopUrl)}" style="color:#0f766e;text-decoration:underline;">Stop these reminders</a>
    </p>
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="margin:0;font-size:12px;line-height:18px;color:#64748b;">
      If a link doesn't work, just reply to this email — a real person reads it.<br />
      Talk soon,<br />
      the ${safePractice} team
    </p>
  </div>
</body>
</html>`;

  return { subject, html, text };
}

export interface RenderClickLandingInput {
  /** Practice display name. Already admin-vetted. */
  practiceName: string;
  /** The action the token encodes — shown to the patient before they commit. */
  action: "confirm" | "edit" | "stop";
  /**
   * The full POST action URL, including the signed `?t=…` query parameter.
   * This is what the HTML form's `action` attribute is set to.
   */
  formActionUrl: string;
}

/**
 * Renders the intermediate landing page shown on GET /email/click before
 * any state-changing action is performed. The page asks the patient to
 * explicitly click a button, which then POSTs to the same URL.
 *
 * This two-step flow prevents corporate email scanners and link-preview
 * systems from triggering order confirmations or preference changes
 * when they pre-fetch the link to check for malware.
 *
 * No PHI is included — we never echo the patient's name on a page that
 * could be forwarded or cached by an intermediary.
 */
export function renderClickLanding(input: RenderClickLandingInput): string {
  const safePractice = escapeHtml(input.practiceName);

  const heading =
    input.action === "confirm"
      ? "Confirm your CPAP resupply order"
      : input.action === "edit"
        ? "Request an address change"
        : "Stop CPAP refill reminders";

  const description =
    input.action === "confirm"
      ? "Click the button below to confirm your order and we'll ship your supplies right away."
      : input.action === "edit"
        ? "Click the button below and a member of our team will reach out about your shipping address."
        : "Click the button below to unsubscribe from CPAP refill reminders. You can always reply to a future email to re-enroll.";

  const buttonLabel =
    input.action === "confirm"
      ? "Confirm my order"
      : input.action === "edit"
        ? "Request address change"
        : "Stop reminders";

  const buttonColor = input.action === "stop" ? "#dc2626" : "#0f766e";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;">
    <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;">
      ${escapeHtml(heading)}
    </h1>
    <p style="margin:0 0 32px;font-size:15px;line-height:22px;color:#334155;">
      ${escapeHtml(description)}
    </p>
    <form method="POST" action="${escapeHtml(input.formActionUrl)}">
      <button type="submit" style="display:inline-block;padding:14px 28px;border-radius:6px;background:${buttonColor};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;border:none;cursor:pointer;">
        ${escapeHtml(buttonLabel)}
      </button>
    </form>
    <p style="margin:24px 0 0;font-size:13px;line-height:18px;color:#64748b;">
      — ${safePractice}
    </p>
  </div>
</body>
</html>`;
}

export interface RenderClickConfirmationInput {
  /** Practice display name. Already admin-vetted. */
  practiceName: string;
  /** What the patient just did. `review` is the entitlement-guard
   *  outcome: the reorder was received but isn't yet payable under the
   *  replacement schedule, so a CSR will follow up before it ships. */
  action: "confirm" | "edit" | "stop" | "review";
}

/**
 * Minimal HTML page returned to the browser after a successful
 * /email/click. Admin confirmations only — no PHI rendered, no
 * dynamic patient name (we don't want a forwarded link to leak the
 * recipient's name to whoever opens it next).
 */
export function renderClickConfirmation(
  input: RenderClickConfirmationInput,
): string {
  const safePractice = escapeHtml(input.practiceName);
  const MESSAGES: Record<RenderClickConfirmationInput["action"], string> = {
    confirm:
      "You're all set — your refill is on the way. We'll text or email tracking the moment it ships.",
    edit: "Got it — someone from our team will be in touch about the address change shortly.",
    stop: "You're unsubscribed from CPAP refill reminders for now — no more emails from us on this. Reply to a past email any time and we'll turn them back on.",
    review:
      "Thanks! It looks like it's a little early to reship this item under your plan, so someone from our team will review and follow up before anything ships.",
  };
  const HEADINGS: Record<RenderClickConfirmationInput["action"], string> = {
    confirm: "Order confirmed",
    edit: "We'll be in touch",
    stop: "Reminders paused",
    review: "We'll be in touch",
  };
  const message = MESSAGES[input.action];
  const heading = HEADINGS[input.action];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;">
    <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;">
      ${escapeHtml(heading)}
    </h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#334155;">
      ${escapeHtml(message)}
    </p>
    <p style="margin:0;font-size:13px;line-height:18px;color:#64748b;">
      — ${safePractice}
    </p>
  </div>
</body>
</html>`;
}

export interface RenderClickErrorInput {
  /** Practice display name. */
  practiceName: string;
  /** Why verification failed (admin-readable). */
  reason: "malformed" | "bad-signature" | "expired" | "unknown-action";
}

/**
 * Minimal HTML error page for failed /email/click verification. We do
 * NOT echo the malformed token, the conversation id, or anything else
 * that could leak between recipients. Just a generic "this link is no
 * longer valid" with a path to recover.
 */
export function renderClickError(input: RenderClickErrorInput): string {
  const safePractice = escapeHtml(input.practiceName);
  const reasonLine =
    input.reason === "expired"
      ? "This link has expired. Reply to the most recent reminder email and we'll help."
      : "This link is no longer valid. Reply to the most recent reminder email and we'll help.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link not valid</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;">
    <h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:600;">
      Link not valid
    </h1>
    <p style="margin:0 0 24px;font-size:15px;line-height:22px;color:#334155;">
      ${escapeHtml(reasonLine)}
    </p>
    <p style="margin:0;font-size:13px;line-height:18px;color:#64748b;">
      — ${safePractice}
    </p>
  </div>
</body>
</html>`;
}
