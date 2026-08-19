// Copy renderers for Rx-renewal nudges.
//
// Lifted out of routes/admin/prescription-renewals.ts (Phase G.15)
// so both the route handler and the daily pg-boss cron call the
// same body templates. Future A/B testing of subject lines / CTAs
// lands here as a single edit that both surfaces pick up.
//
// Branding: the sign-off/sender tag is a caller-supplied parameter
// resolved from the tenant (getCompanyInfo(orgId) in the dispatcher),
// defaulting to the neutral PLATFORM identity — never the seed
// tenant's. Same contract as lib/calendar/appointment-assigned-email.
//
// Template-library seeding: the conditional clauses below (headline,
// SMS status, push title) are exported as standalone fragment helpers
// so the dispatcher can hand them to `renderMessage` as pre-rendered
// variables — the template engine is fixed-syntax `{{var}}` with no
// conditionals, so the seeded `rx_renewal.*` rows (migration 0502)
// interpolate these fragments instead of re-implementing the logic.
// The full renderers compose the same helpers, which is what keeps
// the seeded-template output byte-identical to this fallback path
// (pinned by dispatcher.seeded-template-parity.test.ts).
//
// PHI: no patient identifiers, no SKU, no diagnosis. Greeting +
// first name are sanitized by the caller; days-until-expiry is a
// non-PHI integer used in the headline.

const PLATFORM_BRAND = "CareMetric Breathe";

/**
 * The HTML-context sanitizer this module has always used: STRIP the
 * three markup-significant characters rather than entity-escape them.
 * Exported so the dispatcher's `*_html` template variables apply the
 * exact same transform (a divergence would break seeded-template
 * parity).
 */
export function stripHtmlUnsafe(s: string): string {
  return s.replace(/[<>&]/g, "");
}

export function rxRenewalSubject(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? "Your CPAP prescription has expired"
    : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;
}

/** The email body's opening sentence (plain-text form). */
export function rxRenewalHeadlineText(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? `Your CPAP prescription has just expired.`
    : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}.`;
}

/** The email body's opening sentence (HTML form — bolds the count). */
export function rxRenewalHeadlineHtml(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? `Your CPAP prescription has just expired.`
    : `Your CPAP prescription expires in <strong>${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}</strong>.`;
}

export function rxRenewalText(
  greeting: string,
  daysUntilExpiry: number,
  signoffName = PLATFORM_BRAND,
): string {
  const headline = rxRenewalHeadlineText(daysUntilExpiry);
  return `${greeting},\n\n${headline}\n\nWe need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.\n\nIf you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.\n\n— ${signoffName}\n`;
}

export function rxRenewalHtml(
  greeting: string,
  daysUntilExpiry: number,
  signoffName = PLATFORM_BRAND,
): string {
  const safeGreeting = stripHtmlUnsafe(greeting);
  const safeSignoff = stripHtmlUnsafe(signoffName);
  const headline = rxRenewalHeadlineHtml(daysUntilExpiry);
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${safeGreeting},</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${headline}</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">${safeSignoff}</p>
    </td></tr>
  </table>
</body></html>`;
}

/** The SMS opener: "Hi <first name>" when a name is on file, else "Hi". */
export function rxRenewalSmsGreeting(firstName: string): string {
  return firstName ? `Hi ${firstName}` : "Hi";
}

/** The SMS status clause — 0 / 1 / N-day phrasing. */
export function rxRenewalSmsStatus(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? "your CPAP Rx has just expired"
    : daysUntilExpiry === 1
      ? "your CPAP Rx expires tomorrow"
      : `your CPAP Rx expires in ${daysUntilExpiry} days`;
}

/**
 * Render the SMS body. Kept under 160 ASCII chars in the typical
 * case (firstName under 12 chars + double-digit days) so the
 * message ships as one segment on Twilio. UCS-2 characters would
 * drop the limit to 70/segment, so we deliberately use plain ASCII
 * (regular hyphen, no em-dash).
 *
 * The sender tag is the tenant's storefront brand (caller-resolved,
 * platform default when unset). It is short by convention — a long
 * tenant name can push an 11-char first name past one segment, which
 * is an accepted trade for tenant-correct branding.
 *
 * Reply-mode hint matches the email's "reply to delegate to us"
 * path: patients can text back the physician's name and our
 * messaging dispatcher routes the reply into the existing
 * conversation thread.
 *
 * Carrier-recommended opt-out wording is `STOP to opt out` (vs the
 * shorter `STOP.`); other SMS surfaces in this codebase use the
 * full phrase, so we match for compliance consistency.
 */
export function rxRenewalSms(
  firstName: string,
  daysUntilExpiry: number,
  senderTag = PLATFORM_BRAND,
): string {
  const head = rxRenewalSmsGreeting(firstName);
  const status = rxRenewalSmsStatus(daysUntilExpiry);
  return (
    `${head}, ${status}. Ask your doctor to renew or text us ` +
    `their name + practice. Reply STOP to opt out. - ${senderTag}`
  );
}

export function rxRenewalPushTitle(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? "Your CPAP Rx has expired"
    : `Rx expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;
}

export interface RxRenewalTemplateVarsInput {
  firstName: string;
  greeting: string;
  daysUntilExpiry: number;
  /** Tenant storefront brand (short, SMS-friendly). */
  brandName: string;
  /** Tenant registered legal name (email sign-offs). */
  brandLegalName: string;
}

/**
 * The variable dictionary the dispatcher hands to `renderMessage` for
 * all three rx_renewal.* channels. Names are snake_case + ASCII per the
 * substitution rules. The conditional clauses are pre-rendered here via
 * the fragment helpers above — the {{var}}-only template engine can't
 * express them — which is what keeps the seeded rows (migration 0502)
 * byte-identical to the fallback renderers. Exported so the parity test
 * exercises the exact dictionary the dispatcher uses.
 */
export function buildRxRenewalTemplateVars(
  input: RxRenewalTemplateVarsInput,
): Record<string, string> {
  return {
    first_name: input.firstName,
    days_until_expiry: String(input.daysUntilExpiry),
    greeting: input.greeting,
    brand_name: input.brandName,
    brand_legal_name: input.brandLegalName,
    brand_legal_name_html: stripHtmlUnsafe(input.brandLegalName),
    greeting_html: stripHtmlUnsafe(input.greeting),
    subject_line: rxRenewalSubject(input.daysUntilExpiry),
    headline: rxRenewalHeadlineText(input.daysUntilExpiry),
    headline_html: rxRenewalHeadlineHtml(input.daysUntilExpiry),
    sms_greeting: rxRenewalSmsGreeting(input.firstName),
    rx_status_clause: rxRenewalSmsStatus(input.daysUntilExpiry),
    push_title: rxRenewalPushTitle(input.daysUntilExpiry),
  };
}
