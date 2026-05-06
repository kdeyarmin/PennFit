// Copy renderers for Rx-renewal nudges.
//
// Lifted out of routes/admin/prescription-renewals.ts (Phase G.15)
// so both the route handler and the daily pg-boss cron call the
// same body templates. Future A/B testing of subject lines / CTAs
// lands here as a single edit that both surfaces pick up.
//
// PHI: no patient identifiers, no SKU, no diagnosis. Greeting +
// first name are sanitized by the caller; days-until-expiry is a
// non-PHI integer used in the headline.

export function rxRenewalSubject(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? "Your CPAP prescription has expired"
    : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;
}

export function rxRenewalText(
  greeting: string,
  daysUntilExpiry: number,
): string {
  const headline =
    daysUntilExpiry === 0
      ? `Your CPAP prescription has just expired.`
      : `Your CPAP prescription expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}.`;
  return `${greeting},\n\n${headline}\n\nWe need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.\n\nIf you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.\n\n— Penn Home Medical Supply\n`;
}

export function rxRenewalHtml(
  greeting: string,
  daysUntilExpiry: number,
): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const headline =
    daysUntilExpiry === 0
      ? `Your CPAP prescription has just expired.`
      : `Your CPAP prescription expires in <strong>${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}</strong>.`;
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${safeGreeting},</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${headline}</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.</p>
      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.</p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Penn Home Medical Supply</p>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Render the SMS body. Kept under 160 ASCII chars in the typical
 * case (firstName under 12 chars + double-digit days) so the
 * message ships as one segment on Twilio. UCS-2 characters would
 * drop the limit to 70/segment, so we deliberately use plain ASCII
 * (regular hyphen, no em-dash).
 *
 * The " - Penn Home" sender tag used by smart-trigger SMS bodies is
 * intentionally omitted here: the renewal body is longer and adding
 * the tag would push 11-char names over 160 chars. Twilio's sender
 * number is already registered, so recipients can identify the sender.
 *
 * Reply-mode hint matches the email's "reply to delegate to us"
 * path: patients can text back the physician's name and our
 * messaging dispatcher routes the reply into the existing
 * conversation thread.
 */
export function rxRenewalSms(
  firstName: string,
  daysUntilExpiry: number,
): string {
  const head = firstName ? `Hi ${firstName}` : "Hi";
  const status =
    daysUntilExpiry === 0
      ? "your CPAP Rx has just expired"
      : daysUntilExpiry === 1
        ? "your CPAP Rx expires tomorrow"
        : `your CPAP Rx expires in ${daysUntilExpiry} days`;
  return (
    `${head}, ${status}. Ask your doctor for a renewal so your next supply ships ` +
    `on time, or reply with their name + practice and we'll request it for you. ` +
    `Reply STOP to opt out. - Penn Home Medical Supply`
  );
}

export function rxRenewalPushTitle(daysUntilExpiry: number): string {
  return daysUntilExpiry === 0
    ? "Your CPAP Rx has expired"
    : `Rx expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? "" : "s"}`;
}
