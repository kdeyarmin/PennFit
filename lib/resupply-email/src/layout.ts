// Shared branded email layout — the CareMetric Breathe design system.
//
// Every transactional and marketing email the platform sends shares ONE
// visual identity: a deep-navy header wordmark, a white content card on a
// soft tinted canvas, a single bulletproof call-to-action button, and a
// quiet footer. This module owns that chrome so individual emails only
// supply copy + a CTA — they never hand-roll `<table>` scaffolding again.
//
// Design constraints (these are why it reads the way it does):
//   * Inline styles only. Gmail/Outlook strip `<style>` blocks and `<head>`
//     CSS; every rule that must survive lives on the element.
//   * Table-based, 600px max width. Flexbox/grid don't render in Outlook
//     (Word rendering engine); nested tables are the portable layout.
//   * Bulletproof button. The CTA carries an MSO/VML fallback so Outlook
//     renders a real filled button, not a bare link.
//   * Brand-neutral by parameter. The header wordmark is whatever brand
//     the caller passes — the PLATFORM emails pass "CareMetric Breathe",
//     while a TENANT's transactional email (e.g. a Penn Home Medical Supply patient-portal
//     invite) passes the tenant's own product name. The *look* is shared;
//     the *name* stays correct per the brand architecture in CLAUDE.md.
//
// This package must stay dependency-light (architecture rule 12): no DB,
// no vendor SDKs beyond SendGrid. This file imports nothing.

/** CareMetric Breathe brand palette, lifted from the marketing site's
 *  CSS custom properties (`artifacts/cpap-fitter/src/pages/breathe.css`)
 *  so email and web read as one brand. */
export const BREATHE_COLORS = {
  /** Deep navy — header background, headings. */
  ink: "#0b1426",
  ink2: "#11203c",
  /** Primary action blue — the CTA button. */
  blue: "#2f6fe6",
  blueBright: "#4f8dff",
  cyan: "#54c8ff",
  gold: "#f6a722",
  mint: "#6ff0c2",
  /** Soft page canvas behind the card. */
  canvas: "#eef2fb",
  /** Body copy / muted text. */
  body: "#334155",
  muted: "#6b7280",
  faint: "#9aa6be",
  hairline: "#e6eaf3",
  white: "#ffffff",
} as const;

/** Platform brand wordmark shown in the header when a caller doesn't
 *  override it. Kept in sync with `PLATFORM_NAME` in company-info.ts. */
export const PLATFORM_BRAND_NAME = "CareMetric Breathe";

/**
 * HTML-escape a plain-text value for safe interpolation into email
 * markup. Exported because nearly every email builder needs it — before
 * this lived here, ~20 modules each carried a private copy that drifted
 * (some missed the apostrophe, some missed the quote).
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A single call-to-action on a branded email. */
export interface BrandedEmailButton {
  /** Visible button label, e.g. "Verify your email". */
  label: string;
  /** Destination URL. Rendered into the href as-is (callers pass an
   *  already-built, trusted link). */
  url: string;
}

export interface BrandedEmailOptions {
  /** Wordmark rendered in the header. Defaults to the platform brand. */
  brandName?: string;
  /** Optional short tagline under the wordmark (escaped). */
  brandTagline?: string;
  /** Optional H1 shown at the top of the content card (escaped). */
  heading?: string;
  /** Hidden inbox-preview text (escaped). Falls back to the heading. */
  preheader?: string;
  /**
   * Inner body HTML. The CALLER is responsible for the safety of this
   * string — build it from `paragraph()` / `escapeHtml`-ed values, never
   * by interpolating raw user input. It is injected verbatim into the
   * content cell.
   */
  contentHtml: string;
  /** Optional primary CTA button rendered below the content. */
  button?: BrandedEmailButton;
  /**
   * Footer lines (each escaped + rendered on its own muted row). Use for
   * the company signature, mailing address, and any "why you got this"
   * note. A copyright/year line is appended automatically.
   */
  footerLines?: ReadonlyArray<string>;
  /**
   * Raw footer HTML appended after `footerLines` and before the
   * copyright line — for a one-click unsubscribe link or other markup the
   * escaped `footerLines` can't carry. CALLER is responsible for its
   * safety (escape any dynamic values before passing).
   */
  footerHtml?: string;
  /** Accent color for the CTA + rule. Defaults to the Breathe blue. */
  accent?: string;
  /** Override the auto copyright line (escaped). Pass "" to omit it. */
  copyrightName?: string;
  /**
   * Override the copyright year. Defaults to the current year.
   *
   * Exists so a body can be rendered DETERMINISTICALLY: the seeded
   * message-template rows (`seed-bodies.ts`) build their stored HTML by
   * calling this renderer with `{{...}}` placeholders, and a
   * `new Date()`-derived year would bake the build year into the row and
   * silently drift every January. Those seeds pass `"{{copyright_year}}"`
   * and their dispatcher supplies the real value at send time.
   */
  copyrightYear?: number | string;
}

/** Render one body paragraph with the shared type treatment. The inner
 *  HTML is injected verbatim — escape any dynamic values before calling. */
export function paragraph(innerHtml: string): string {
  return `<p style="margin:0 0 16px;color:${BREATHE_COLORS.body};font-size:16px;line-height:1.6;">${innerHtml}</p>`;
}

/** Convenience: a paragraph built from PLAIN TEXT (auto-escaped). */
export function textParagraph(text: string): string {
  return paragraph(escapeHtml(text));
}

/**
 * A "bulletproof" CTA button — renders as a real filled button in Outlook
 * (via the MSO/VML conditional comment) and as a padded rounded anchor
 * everywhere else. `url` is emitted into the href unescaped on the
 * assumption the caller passes a trusted, already-encoded link.
 */
export function brandedButton(
  label: string,
  url: string,
  accent: string = BREATHE_COLORS.blue,
): string {
  const safeLabel = escapeHtml(label);
  const safeHref = url.replace(/"/g, "&quot;");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 8px;"><tr><td align="center" bgcolor="${accent}" style="border-radius:10px;">
<!--[if mso]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeHref}" style="height:48px;v-text-anchor:middle;width:300px;" arcsize="20%" stroke="f" fillcolor="${accent}">
<w:anchorlock/>
<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${safeLabel}</center>
</v:roundrect>
<![endif]-->
<!--[if !mso]><!-- -->
<a href="${safeHref}" style="display:inline-block;padding:14px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;background:${accent};">${safeLabel}</a>
<!--<![endif]-->
</td></tr></table>`;
}

/**
 * A secondary, lower-emphasis action rendered under the primary CTA —
 * e.g. "or browse the shop". Plain underlined link, never a second
 * button (two buttons of equal weight read as indecision).
 */
export function secondaryLink(
  label: string,
  url: string,
  accent: string = BREATHE_COLORS.blue,
): string {
  return `<div style="text-align:center;margin:4px 0 0;"><a href="${url.replace(
    /"/g,
    "&quot;",
  )}" style="color:${accent};font-family:Arial,Helvetica,sans-serif;font-size:13px;text-decoration:underline;">${escapeHtml(
    label,
  )}</a></div>`;
}

/** A subheading inside the content card (e.g. "Shipping to"). */
export function subheading(text: string): string {
  return `<div style="margin:24px 0 8px;color:${BREATHE_COLORS.ink};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;letter-spacing:0.02em;">${escapeHtml(
    text,
  )}</div>`;
}

/** A full-width hairline rule between sections. */
export function divider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="height:1px;background:${BREATHE_COLORS.hairline};font-size:0;line-height:0;padding:0;">&nbsp;</td></tr></table>`;
}

/** One line item on an order/summary table. */
export interface EmailLineItem {
  /** Product or service name (escaped). */
  name: string;
  /** Optional second line under the name, e.g. "Size: Medium" (escaped). */
  detail?: string;
  /** Right-hand column, e.g. "2 × $45.00" (escaped). */
  amount?: string;
}

/**
 * Render an order/line-item table with the shared type treatment: name
 * (and optional detail) on the left, amount right-aligned, hairline
 * between rows. Values are escaped — pass plain text.
 */
export function lineItemsTable(items: ReadonlyArray<EmailLineItem>): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (it) => `<tr>
<td style="padding:10px 0;border-bottom:1px solid ${BREATHE_COLORS.hairline};font-family:Arial,Helvetica,sans-serif;">
<div style="color:${BREATHE_COLORS.ink};font-size:15px;font-weight:600;line-height:1.4;">${escapeHtml(
        it.name,
      )}</div>${
        it.detail
          ? `<div style="margin-top:2px;color:${BREATHE_COLORS.muted};font-size:13px;line-height:1.4;">${escapeHtml(
              it.detail,
            )}</div>`
          : ""
      }
</td>
<td align="right" style="padding:10px 0;border-bottom:1px solid ${BREATHE_COLORS.hairline};font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.body};font-size:14px;white-space:nowrap;vertical-align:top;">${
        it.amount ? escapeHtml(it.amount) : ""
      }</td>
</tr>`,
    )
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;">
${rows}
</table>`;
}

/** A label/value row in a summary block (e.g. "Total" / "$90.00"). */
export interface EmailSummaryRow {
  label: string;
  value: string;
  /** Render bold + full-ink, for the grand total row. */
  emphasis?: boolean;
}

/**
 * Render label/value summary rows (subtotal, shipping, total). Values
 * are escaped — pass plain text.
 */
export function summaryRows(rows: ReadonlyArray<EmailSummaryRow>): string {
  if (rows.length === 0) return "";
  const body = rows
    .map((r) => {
      const color = r.emphasis ? BREATHE_COLORS.ink : BREATHE_COLORS.body;
      const weight = r.emphasis ? "700" : "400";
      const size = r.emphasis ? "16px" : "14px";
      return `<tr>
<td style="padding:6px 0 0;font-family:Arial,Helvetica,sans-serif;color:${color};font-size:${size};font-weight:${weight};">${escapeHtml(
        r.label,
      )}</td>
<td align="right" style="padding:6px 0 0;font-family:Arial,Helvetica,sans-serif;color:${color};font-size:${size};font-weight:${weight};white-space:nowrap;">${escapeHtml(
        r.value,
      )}</td>
</tr>`;
    })
    .join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 0;">
${body}
</table>`;
}

/** Visual tone of an {@link infoPanel}. */
export type EmailPanelTone = "neutral" | "info" | "success" | "warning";

const PANEL_TONES: Record<EmailPanelTone, { bg: string; border: string }> = {
  neutral: { bg: "#f6f8fc", border: BREATHE_COLORS.hairline },
  info: { bg: "#eef4ff", border: "#c9dcff" },
  success: { bg: "#eefbf4", border: "#bfe9d4" },
  warning: { bg: "#fff7e8", border: "#f6dfae" },
};

export interface EmailPanelOptions {
  /** Optional bold label above the panel body (escaped). */
  title?: string;
  /** Panel body HTML — escape any dynamic values before passing. */
  html: string;
  /** Background/border treatment. Defaults to `neutral`. */
  tone?: EmailPanelTone;
}

/**
 * A tinted callout box — used for shipping addresses, tracking numbers,
 * "what happens next" notes, and alert summaries. Table-based so it
 * survives Outlook (a bare `<div>` with a background does not reliably
 * paint edge-to-edge in the Word rendering engine).
 */
export function infoPanel(opts: EmailPanelOptions): string {
  const tone = PANEL_TONES[opts.tone ?? "neutral"];
  const titleHtml = opts.title
    ? `<div style="margin:0 0 6px;color:${BREATHE_COLORS.ink};font-size:13px;font-weight:700;letter-spacing:0.02em;">${escapeHtml(
        opts.title,
      )}</div>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0;">
<tr><td style="background:${tone.bg};border:1px solid ${tone.border};border-radius:10px;padding:16px 18px;font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.body};font-size:14px;line-height:1.6;">
${titleHtml}${opts.html}
</td></tr>
</table>`;
}

/**
 * A bulleted list with email-safe spacing. Items are escaped — pass
 * plain text.
 */
export function bulletList(items: ReadonlyArray<string>): string {
  if (items.length === 0) return "";
  const lis = items
    .map(
      (t) =>
        `<li style="margin:0 0 6px;color:${BREATHE_COLORS.body};font-size:15px;line-height:1.6;">${escapeHtml(
          t,
        )}</li>`,
    )
    .join("\n");
  return `<ul style="margin:0 0 16px;padding-left:22px;font-family:Arial,Helvetica,sans-serif;">
${lis}
</ul>`;
}

/**
 * Wrap caller-supplied content in the full branded HTML document. Returns
 * a complete `<!doctype html>` string ready to hand to `sendEmail({ html })`.
 */
export function renderBrandedEmail(opts: BrandedEmailOptions): string {
  const brand = opts.brandName?.trim() || PLATFORM_BRAND_NAME;
  const accent = opts.accent || BREATHE_COLORS.blue;
  const preheaderText = opts.preheader ?? opts.heading ?? "";
  const year = opts.copyrightYear ?? new Date().getFullYear();

  const headingHtml = opts.heading
    ? `<h1 style="margin:0 0 20px;color:${BREATHE_COLORS.ink};font-size:24px;line-height:1.3;font-weight:700;">${escapeHtml(
        opts.heading,
      )}</h1>`
    : "";

  const taglineHtml = opts.brandTagline
    ? `<div style="margin:6px 0 0;color:${BREATHE_COLORS.cyan};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(
        opts.brandTagline,
      )}</div>`
    : "";

  const buttonHtml = opts.button
    ? brandedButton(opts.button.label, opts.button.url, accent)
    : "";

  const copyrightName =
    opts.copyrightName === undefined ? brand : opts.copyrightName;
  const footerRows = [
    ...(opts.footerLines ?? []).map(
      (line) =>
        `<div style="margin:0 0 6px;color:${BREATHE_COLORS.faint};font-size:12px;line-height:1.5;">${escapeHtml(
          line,
        )}</div>`,
    ),
    ...(opts.footerHtml
      ? [
          `<div style="margin:0 0 6px;color:${BREATHE_COLORS.faint};font-size:12px;line-height:1.5;">${opts.footerHtml}</div>`,
        ]
      : []),
    ...(copyrightName
      ? [
          `<div style="margin:8px 0 0;color:${BREATHE_COLORS.faint};font-size:12px;line-height:1.5;">© ${year} ${escapeHtml(
            copyrightName,
          )}. All rights reserved.</div>`,
        ]
      : []),
  ].join("\n");

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>${escapeHtml(brand)}</title>
<!--[if mso]><style>table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:${BREATHE_COLORS.canvas};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BREATHE_COLORS.canvas};">${escapeHtml(
    preheaderText,
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BREATHE_COLORS.canvas};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${BREATHE_COLORS.white};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(11,20,38,0.08);">
<!-- Header -->
<tr><td style="background:${BREATHE_COLORS.ink};background:linear-gradient(135deg,${BREATHE_COLORS.ink} 0%,${BREATHE_COLORS.ink2} 100%);padding:28px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left">
<div style="color:${BREATHE_COLORS.white};font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:700;letter-spacing:-0.01em;">${escapeHtml(
    brand,
  )}</div>
${taglineHtml}
</td>
<td align="right" style="vertical-align:middle;">
<span style="display:inline-block;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,${BREATHE_COLORS.cyan} 0%,${BREATHE_COLORS.blue} 100%);"></span>
</td></tr></table>
</td></tr>
<!-- Accent rule -->
<tr><td style="height:4px;background:linear-gradient(90deg,${BREATHE_COLORS.cyan} 0%,${BREATHE_COLORS.blue} 50%,${BREATHE_COLORS.gold} 100%);font-size:0;line-height:0;">&nbsp;</td></tr>
<!-- Body -->
<tr><td style="padding:40px;font-family:Arial,Helvetica,sans-serif;">
${headingHtml}${opts.contentHtml}
${
  buttonHtml
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:12px 0 8px;">${buttonHtml}</td></tr></table>`
    : ""
}
</td></tr>
<!-- Footer -->
<tr><td style="padding:24px 40px 32px;border-top:1px solid ${BREATHE_COLORS.hairline};font-family:Arial,Helvetica,sans-serif;">
${footerRows}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
