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

// The branded chrome comes from the shared email design system. We import
// the `/layout` SUBPATH deliberately: it is a pure, dependency-free string
// module with no SendGrid code in it, so this stays a vendor-agnostic
// semantic layer (architecture Rule 11) while still rendering the one
// platform-wide email identity.
import {
  BREATHE_COLORS,
  renderBrandedEmail,
  subheading,
  textParagraph,
} from "@workspace/resupply-email/layout";

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
  /** "Not this time." OPTIONAL so existing callers and their specs keep
   *  compiling; when absent the email renders the three original actions.
   *  Email had no negative action short of a permanent opt-out, so a
   *  patient who just wanted to skip one cycle either ignored us (and got
   *  escalated to a phone call) or unsubscribed from resupply entirely. */
  declineUrl?: string;
  /** Signed link the "Stop reminders" CTA points at. */
  stopUrl: string;
  /**
   * Which touch in the escalation ladder this is — drives the subject +
   * opening line so a follow-up doesn't read identically to the first
   * reminder. Defaults to "initial" (the first touch's copy, unchanged).
   */
  variant?: ReminderVariant;
}

/**
 * Escalation-step copy variant for resupply reminders. Lives in the
 * messaging lib (the shared "templates" home) so both the email template
 * here and the SMS body in @workspace/resupply-reminders pick from the same
 * vocabulary:
 *   - "initial"  — first touch (gentle "you're due").
 *   - "followup" — a later touch with MORE outreach still to come
 *     ("just circling back").
 *   - "final"    — the LAST automated touch before a human is asked to call
 *     ("last call").
 */
export type ReminderVariant = "initial" | "followup" | "final";

interface ReminderVariantCopy {
  /** Subject line + heading (no PHI). */
  subject: string;
  /** Opening sentence in the plain-text body (practice name pre-interpolated). */
  introText: string;
  /** Same opening sentence for the HTML body, with the practice name
   *  pre-escaped. It is a complete sentence in its own paragraph (it used
   *  to be spliced onto "Hi {name} — ", which read as a run-on). */
  introHtml: string;
}

/** Resolve the subject + opening line for a reminder variant. */
function reminderVariantCopy(
  variant: ReminderVariant,
  practiceName: string,
  safePractice: string,
): ReminderVariantCopy {
  switch (variant) {
    case "followup":
      return {
        subject: "Still time to refill your CPAP supplies",
        introText: `Just circling back from ${practiceName}. Your CPAP refill is ready whenever you are. Here's what's due:`,
        introHtml: `Just circling back from ${safePractice}. Your CPAP refill is ready whenever you are. Here's what's due:`,
      };
    case "final":
      return {
        subject: "Last call: your CPAP refill is ready",
        introText: `This is our last reminder. We don't want you to run low, and ${practiceName} can ship today. Here's what's due:`,
        introHtml: `This is our last reminder. We don't want you to run low, and ${safePractice} can ship today. Here's what's due:`,
      };
    case "initial":
    default:
      return {
        subject: "Time to refill your CPAP supplies",
        introText: `You're due for a CPAP refill. ${practiceName} has your next order ready. Here's what's due:`,
        introHtml: `You're due for a CPAP refill. ${safePractice} has your next order ready. Here's what's due:`,
      };
  }
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
  const safePractice = escapeHtml(input.practiceName);
  const variantCopy = reminderVariantCopy(
    input.variant ?? "initial",
    input.practiceName,
    safePractice,
  );
  const subject = variantCopy.subject;
  const itemsTextLines = input.items
    .map((it) => `  • ${it.name} × ${it.quantity}`)
    .join("\n");
  const itemsHtmlLines = input.items
    .map(
      (it) =>
        `<li style="margin:4px 0;">${escapeHtml(it.name)} × ${it.quantity}</li>`,
    )
    .join("");

  // Body copy is deliberately plain: short sentences, one idea each, and
  // the directions written as numbered steps a patient can follow without
  // re-reading. Labelled sections ("Why this matters", "What to do") let
  // someone skim to the part they need.
  const text = [
    `Hi ${input.firstName},`,
    "",
    variantCopy.introText,
    "",
    itemsTextLines || "  (your supplies, per your prescription)",
    "",
    "WHY THIS MATTERS",
    "A worn cushion leaks. An old filter makes your machine work harder. Fresh supplies keep your therapy working the way it should.",
    "",
    "WHAT IT COSTS",
    "Most plans cover these replacements. We check your coverage before anything ships, so you won't get a surprise bill.",
    "",
    "WHAT TO DO",
    "Pick one of the links below. You don't need a password or an account.",
    "",
    "1. Send my supplies",
    "   Use this if you still use your CPAP and are running low. We check your plan, then ship to the address we have on file. If anything needs a closer look, a team member will contact you first.",
    `   ${input.confirmUrl}`,
    "",
    "2. Change my shipping address",
    "   Use this if you have moved. A team member will call or email you to confirm the new address.",
    `   ${input.editUrl}`,
    "",
    ...(input.declineUrl
      ? [
          "3. Skip this refill",
          "   Use this if you don't need supplies right now. We'll check back at your next refill. You stay enrolled.",
          `   ${input.declineUrl}`,
          "",
          "4. Stop these reminders",
          "   Use this if you don't want refill reminders at all. You can turn them back on any time by replying to one of our emails.",
          `   ${input.stopUrl}`,
        ]
      : [
          "3. Stop these reminders",
          "   Use this if you don't want refill reminders. You can turn them back on any time by replying to one of our emails.",
          `   ${input.stopUrl}`,
        ]),
    "",
    "If a link doesn't work, just reply to this email. A real person reads it.",
    "",
    "Talk soon,",
    `the ${input.practiceName} team`,
  ].join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system:
  // table-based 600px card, MSO/VML bulletproof CTA, hidden preheader.
  // This function supplies only copy. The three patient actions are one
  // primary button ("Send my supplies") plus two secondary links, so the
  // hierarchy matches what we want the patient to do.
  const html = renderBrandedEmail({
    brandName: input.practiceName,
    heading: subject,
    preheader: variantCopy.introText,
    contentHtml: [
      textParagraph(`Hi ${input.firstName},`),
      `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.body};font-size:16px;line-height:1.6;">${variantCopy.introHtml}</p>`,
      `<ul style="margin:0 0 24px;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${BREATHE_COLORS.body};">${
        itemsHtmlLines ||
        `<li style="margin:4px 0;">Your supplies, per your prescription.</li>`
      }</ul>`,
      subheading("Why this matters"),
      textParagraph(
        "A worn cushion leaks. An old filter makes your machine work harder. Fresh supplies keep your therapy working the way it should.",
      ),
      subheading("What it costs"),
      textParagraph(
        "Most plans cover these replacements. We check your coverage before anything ships, so you won't get a surprise bill.",
      ),
      subheading("What to do"),
      textParagraph(
        "Pick one of the buttons below. You don't need a password or an account.",
      ),
      `<p style="margin:0 0 8px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${BREATHE_COLORS.body};"><strong>1. Send my supplies.</strong> Use this if you still use your CPAP and are running low. We check your plan, then ship to the address we have on file. If anything needs a closer look, a team member will contact you first.</p>`,
    ].join("\n"),
    button: { label: "Send my supplies", url: safeHref(input.confirmUrl) },
    // Actions 2 and 3 go in the post-button slot, NOT the footer: the
    // footer renders after the "Talk soon" sign-off, which would have the
    // numbered workflow finish before two of its three steps appeared —
    // and would bury the opt-out below the closing.
    postButtonHtml:
      `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${BREATHE_COLORS.body};"><strong>2. Change my shipping address.</strong> Use this if you have moved. A team member will call or email you to confirm the new address.<br /><a href="${safeHref(
        input.editUrl,
      )}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Change my shipping address</a></p>` +
      // "Skip this refill" sits directly under the address action and
      // ABOVE the opt-out, and is worded so the two cannot be confused.
      // Reading them as the same thing is how someone unsubscribes from
      // resupply when they only meant "not right now".
      (input.declineUrl
        ? `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${BREATHE_COLORS.body};"><strong>3. Skip this refill.</strong> Use this if you don't need supplies right now. We'll check back at your next refill — you stay enrolled.<br /><a href="${safeHref(
            input.declineUrl,
          )}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Skip this refill</a></p>`
        : "") +
      `<p style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${BREATHE_COLORS.body};"><strong>${
        input.declineUrl ? "4" : "3"
      }. Stop these reminders.</strong> Use this if you don't want refill reminders at all. You can turn them back on any time by replying to one of our emails.<br /><a href="${safeHref(
        input.stopUrl,
      )}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Stop these reminders</a></p>`,
    footerLines: [
      "If a link doesn't work, just reply to this email. A real person reads it.",
      `Talk soon, the ${input.practiceName} team`,
    ],
    copyrightName: input.practiceName,
  });

  return { subject, html, text };
}

export interface ClickLandingItem {
  /** Friendly supply name, e.g. "Nasal mask cushion". */
  name: string;
  /** HCPCS category (mask | cushion | pillow | filter | tubing |
   *  headgear | chinstrap | chamber | device | other) — drives the
   *  color + glyph so the patient can recognize the item at a glance. */
  category: string;
  /** Quantity due. */
  quantity: number;
  /**
   * Optional product photo URL. When present it's rendered as the item
   * thumbnail; when absent (the common case today — resupply SKUs map to
   * an HCPCS family, not a specific photographed product) a category
   * glyph tile is shown instead. NOT PHI — a product reference only.
   * Must be an https URL the patient's browser can load directly.
   */
  imageUrl?: string | null;
}

/**
 * Simple, self-contained line glyphs per supply category, shown on a
 * color-filled tile so each due item reads as a recognizable picture
 * rather than a bare text row — the visual is the lever on confirmation
 * rate. Inline SVG (no external fetch, no broken-image box, no privacy
 * leak) and renders in every browser that opens the landing page.
 * Stroke is white over the category color; viewBox is 24×24.
 */
const CATEGORY_ICON_PATHS: Record<string, string> = {
  mask: '<path d="M3 9c0-1.1.9-2 2-2h14a2 2 0 0 1 2 2v2c0 4.4-4 7-9 7s-9-2.6-9-7V9z"/>',
  cushion: '<rect x="3.5" y="7.5" width="17" height="9" rx="4.5"/>',
  pillow: '<rect x="3.5" y="7.5" width="17" height="9" rx="4.5"/>',
  filter:
    '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M5 10h14M5 14h14"/>',
  tubing: '<path d="M4 13c2-5 6-5 8 0s6 4 8-1"/>',
  headgear:
    '<rect x="4" y="9" width="16" height="6" rx="3"/><path d="M9 9v6M15 9v6"/>',
  chinstrap:
    '<rect x="4" y="9" width="16" height="6" rx="3"/><path d="M9 9v6M15 9v6"/>',
  chamber: '<path d="M12 4s6 6 6 10a6 6 0 0 1-12 0c0-4 6-10 6-10z"/>',
  device:
    '<rect x="4" y="7" width="16" height="11" rx="2"/><circle cx="9" cy="12.5" r="1.6"/>',
  other:
    '<path d="M4 8l8-4 8 4v8l-8 4-8-4V8z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
};

function iconSvgFor(category: string): string {
  const path = CATEGORY_ICON_PATHS[category] ?? CATEGORY_ICON_PATHS.other;
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export interface RenderClickLandingInput {
  /** Practice display name. Already admin-vetted. */
  practiceName: string;
  /** The action the token encodes — shown to the patient before they commit. */
  action: "confirm" | "edit" | "stop" | "decline";
  /**
   * The full POST action URL, including the signed `?t=…` query parameter.
   * This is what the HTML form's `action` attribute is set to.
   */
  formActionUrl: string;
  /**
   * The supplies due on this order. Rendered as a card list on the
   * `confirm` action so the patient sees exactly what's shipping before
   * they tap — the single biggest lever on resupply confirmation rate.
   * Omitted/empty → the page renders without the list (back-compat).
   * NOT PHI: supply names + quantities are product references only.
   */
  items?: ClickLandingItem[];
  /**
   * The Medicare/payer refill attestation the patient agrees to by
   * confirming. Rendered as an explicit statement directly above the
   * confirm button so the click is an informed affirmation that they
   * still use the equipment and are running low. Only shown for the
   * `confirm` action; omitted → not rendered (back-compat).
   */
  attestationText?: string;
}

/** Color chip per supply category for the landing-page item cards. */
const CATEGORY_CHIP_COLOR: Record<string, string> = {
  mask: "#0ea5e9",
  cushion: "#14b8a6",
  pillow: "#8b5cf6",
  filter: "#f59e0b",
  tubing: "#6366f1",
  headgear: "#ec4899",
  chinstrap: "#ec4899",
  chamber: "#06b6d4",
  device: "#64748b",
  other: "#94a3b8",
};

function renderLandingItems(items: ClickLandingItem[]): string {
  const rows = items
    .map((it) => {
      const color =
        CATEGORY_CHIP_COLOR[it.category] ?? CATEGORY_CHIP_COLOR.other;
      const qty = Number.isFinite(it.quantity) ? Math.max(1, it.quantity) : 1;
      // A real product photo when we have one, else a category glyph
      // on a color tile. Both render at 40×40 so rows stay aligned.
      const thumb =
        typeof it.imageUrl === "string" && it.imageUrl.length > 0
          ? `<img src="${escapeHtml(it.imageUrl)}" alt="" width="40" height="40" style="flex:0 0 auto;width:40px;height:40px;border-radius:8px;object-fit:cover;margin-right:14px;border:1px solid #e2e8f0;" />`
          : `<div style="flex:0 0 auto;width:40px;height:40px;border-radius:8px;background:${color};margin-right:14px;display:flex;align-items:center;justify-content:center;">${iconSvgFor(it.category)}</div>`;
      return `      <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid #f1f5f9;text-align:left;">
        ${thumb}
        <div style="flex:1 1 auto;">
          <div style="font-size:15px;font-weight:600;color:#0f172a;">${escapeHtml(it.name)}</div>
          <div style="font-size:13px;color:#64748b;">Qty ${qty}</div>
        </div>
      </div>`;
    })
    .join("\n");
  return `    <div style="margin:0 0 28px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <div style="padding:10px 16px;background:#f8fafc;font-size:13px;font-weight:600;color:#475569;border-bottom:1px solid #e2e8f0;text-align:left;">Your supplies due now</div>
${rows}
    </div>`;
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
 * could be forwarded or cached by an intermediary. Supply names and
 * quantities (the item cards) are product references, not PHI.
 */
export function renderClickLanding(input: RenderClickLandingInput): string {
  const safePractice = escapeHtml(input.practiceName);

  const heading =
    input.action === "confirm"
      ? "Confirm your CPAP supply order"
      : input.action === "edit"
        ? "Change your shipping address"
        : input.action === "decline"
          ? "Skip this refill"
          : "Stop CPAP refill reminders";

  // One step per page, stated plainly, plus what happens after the tap so
  // nobody has to guess. "Use the button" reads correctly on a phone and a
  // desktop alike (the page was mixing "Tap" and "Click").
  //
  // The confirm copy must NOT promise shipment. POST /email/click runs the
  // entitlement, coverage, continued-use and refill-window guards, and any
  // one of them renders the `review` confirmation ("a team member will
  // check it") instead of shipping. Promising "we will ship" here would
  // make that outcome read as a broken promise.
  const hasItems = !!input.items && input.items.length > 0;
  const description =
    input.action === "confirm"
      ? hasItems
        ? "Here is what is due. Use the button below to confirm. We will check your plan, then ship to the address we have on file. If anything needs a closer look, a team member will contact you first."
        : "Use the button below to confirm. We will check your plan, then ship your supplies to the address we have on file. If anything needs a closer look, a team member will contact you first."
      : input.action === "edit"
        ? "Use the button below to ask for an address change. We'll hold any order that hasn't shipped yet, so nothing goes to your old address, and a team member will call or email you to confirm the new one."
        : input.action === "decline"
          ? // Skipping and unsubscribing must not read alike, or people
            // opt out of resupply when they only meant "not right now".
            "Use the button below if you don't need supplies this time. We'll skip this refill and check back at your next one. You stay enrolled — this doesn't stop your reminders."
          : "Use the button below to stop CPAP refill reminders. You can turn them back on any time by replying to one of our emails.";

  const buttonLabel =
    input.action === "confirm"
      ? "Confirm my order"
      : input.action === "edit"
        ? "Request an address change"
        : input.action === "decline"
          ? "Skip this refill"
          : "Stop reminders";

  const buttonColor = input.action === "stop" ? "#dc2626" : "#0f766e";

  const itemsBlock =
    input.action === "confirm" && input.items && input.items.length > 0
      ? renderLandingItems(input.items)
      : "";

  // Explicit refill attestation shown directly above the confirm button
  // so the click is an informed Medicare/payer affirmation (still using
  // the equipment + supplies running low), and a screenshot of this page
  // is itself the proof of what the patient agreed to.
  const attestationBlock =
    input.action === "confirm" &&
    typeof input.attestationText === "string" &&
    input.attestationText.length > 0
      ? `    <div style="margin:0 0 20px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;text-align:left;">
      <div style="font-size:13px;font-weight:600;color:#475569;margin:0 0 6px;">Please confirm</div>
      <p style="margin:0;font-size:14px;line-height:21px;color:#334155;">${escapeHtml(input.attestationText)}</p>
    </div>`
      : "";

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
${itemsBlock}
${attestationBlock}
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
   *  replacement schedule, so a CSR will follow up before it ships.
   *  `address_pending` is the address-change hold: they asked us to move
   *  their address, so nothing ships until a team member confirms it. */
  action:
    | "confirm"
    | "edit"
    | "stop"
    | "decline"
    | "review"
    | "address_pending";
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
  // Each message says what just happened, then what happens next. No
  // jargon ("unsubscribed", "re-enroll") and no open loops.
  const MESSAGES: Record<RenderClickConfirmationInput["action"], string> = {
    confirm:
      "You're all set. Your supplies are on the way to the address we have on file. We'll text or email you tracking as soon as they ship. You don't need to do anything else.",
    edit: "Thanks. We have your address change request. We've put any order that hasn't shipped on hold, so nothing goes to your old address. A team member will call or email you within one business day to confirm the new one.",
    stop: "Done. We've stopped CPAP refill reminders, so you won't get any more of these emails. If you change your mind, reply to any of our past emails and we'll turn them back on.",
    decline:
      "Got it. We won't send anything this time. You're still enrolled, and we'll check back when your next refill comes around. If you change your mind before then, just reply to this email.",
    review:
      "Thanks. It looks like it's a little early to resend this item under your plan, so a team member will check it and follow up with you before anything ships. You don't need to do anything right now.",
    address_pending:
      "Thanks. You asked us to change your shipping address, so we're holding this order until a team member confirms the new one with you. They'll call or email you within one business day. Nothing ships until then.",
  };
  const HEADINGS: Record<RenderClickConfirmationInput["action"], string> = {
    confirm: "Order confirmed",
    edit: "We'll be in touch",
    stop: "Reminders stopped",
    decline: "Refill skipped",
    review: "We'll be in touch",
    address_pending: "Order held",
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
      ? "This link has expired. To pick up where you left off, reply to the most recent reminder email we sent you and a team member will help."
      : "This link no longer works. To pick up where you left off, reply to the most recent reminder email we sent you and a team member will help.";

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
