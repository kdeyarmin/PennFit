// sendLifecycleTouchpointEmail — once-yearly birthday + sleep-
// therapy anniversary celebration email.
//
// Why a dedicated helper
// ----------------------
// Birthday + anniversary touchpoints have outsized open rates in
// adherence-coaching research, but only if the copy is warm and
// brand-aligned — a generic "we noticed it's your birthday" template
// drops open rates by half. Two short, hand-tuned variants beat one
// merge field every time.
//
// Marketing posture
// -----------------
// Gated upstream by communication_preferences.emailMarketing. The
// email itself includes a footer unsubscribe link. We deliberately
// keep the body soft — no upsell, no discount code, no resupply
// reminder. The point is the relationship signal, not the next sale.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type LifecycleKind = "birthday" | "sleep_anniversary";

export interface SendLifecycleTouchpointEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: LifecycleKind;
  /**
   * For "sleep_anniversary" the worker knows how many years they've
   * been on therapy; we surface "X years of CPAP" in the headline.
   * Ignored for "birthday".
   */
  yearsOnTherapy?: number;
  baseUrlOverride?: string;
}

export interface SendLifecycleTouchpointEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

interface Copy {
  subject: string;
  headline: string;
  body: string;
}

function copyFor(
  kind: LifecycleKind,
  yearsOnTherapy: number | undefined,
): Copy {
  if (kind === "birthday") {
    return {
      subject: "Happy birthday from PennPaps",
      headline: "Happy birthday",
      body:
        "From the team that takes care of your sleep supplies — happy birthday. " +
        "Cardiovascular health, mental clarity, energy through the day — every one of " +
        "those starts with a good night's sleep, and you've been showing up for that. " +
        "Here's to another year of feeling rested.",
    };
  }
  const yearsLabel =
    yearsOnTherapy && yearsOnTherapy > 0
      ? yearsOnTherapy === 1
        ? "1 year"
        : `${yearsOnTherapy} years`
      : "another year";
  return {
    subject: `Anniversary: ${yearsLabel} of CPAP therapy`,
    headline: `${yearsLabel} on therapy`,
    body:
      `Today marks ${yearsLabel} since your first night on CPAP therapy with us. ` +
      "Most patients who stay with therapy past the first year stay with it for life — " +
      "and the long-term cardiovascular and cognitive benefits compound. " +
      "We're glad we've been part of the ride.",
  };
}

export async function sendLifecycleTouchpointEmail(
  input: SendLifecycleTouchpointEmailInput,
): Promise<SendLifecycleTouchpointEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const c = copyFor(input.kind, input.yearsOnTherapy);
  const base = publicBaseUrl(input.baseUrlOverride);
  const prefsUrl = `${base}/account#comm-prefs`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    c.body,
    "",
    "—The PennPaps team",
    "",
    `Manage these emails: ${prefsUrl}`,
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:24px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">${input.kind === "birthday" ? "Birthday" : "Anniversary"}</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:600;">${escapeHtml(c.headline)}</h1>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#3c4458;">
            ${escapeHtml(c.body)}
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          The PennPaps team &nbsp;&middot;&nbsp;
          <a href="${escapeHtml(prefsUrl)}" style="color:#0f1d3a;text-decoration:none;">Manage these emails</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject: c.subject,
      text,
      html,
      customArgs: { kind: `lifecycle_${input.kind}` },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return { configured: true, delivered: false, error: err.message };
    }
    throw err;
  }
}
