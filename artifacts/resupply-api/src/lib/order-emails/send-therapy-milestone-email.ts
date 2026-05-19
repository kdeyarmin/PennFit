// sendTherapyMilestoneEmail — celebration email for a CPAP-adherence
// milestone (100 nights, first-year, first-30-day adherence window).
//
// Why a dedicated helper
// ----------------------
// Three reasons it doesn't go through the generic message-template
// renderer:
//   1. The copy is celebratory and bespoke per milestone — the same
//      template for "100 nights" and "1 year" would feel canned.
//   2. The send needs to fail-open on missing SendGrid config; the
//      generic renderer assumes a configured channel.
//   3. We want the worker to remain free of @workspace/resupply-templates
//      since the per-milestone copy is small enough to inline cleanly.
//
// Fired from the therapy-milestones cron after the milestone row is
// inserted but before its notified_at is stamped — the same atomic-
// claim pattern used by the shipping notification.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type MilestoneKind =
  | "100_nights"
  | "365_nights"
  | "first_adherence_month";

export interface SendTherapyMilestoneEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: MilestoneKind;
  /**
   * Optional metric snapshot for the body copy.
   *   100_nights / 365_nights → `totalNights`
   *   first_adherence_month  → `adherencePct`
   */
  metrics?: {
    totalNights?: number;
    adherencePct?: number;
  };
  baseUrlOverride?: string;
}

export interface SendTherapyMilestoneEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

interface Copy {
  subject: string;
  headline: string;
  body: string;
}

function copyFor(
  kind: MilestoneKind,
  metrics: SendTherapyMilestoneEmailInput["metrics"],
): Copy {
  if (kind === "100_nights") {
    return {
      subject: "100 nights on therapy — congratulations",
      headline: "100 nights and counting",
      body:
        "You just hit 100 nights of CPAP therapy. That's a real milestone — the early weeks are the hardest, and you stuck with it. " +
        "Your sleep quality, oxygen levels, and heart all thank you.",
    };
  }
  if (kind === "365_nights") {
    return {
      subject: "One year of CPAP therapy",
      headline: "One year on therapy",
      body:
        "A full year of CPAP therapy — that's a huge achievement. " +
        "Most patients who hit a year stay with therapy for life, and the cardiovascular benefits compound. " +
        "We're glad we've been part of the ride.",
    };
  }
  // first_adherence_month
  const pct = metrics?.adherencePct;
  return {
    subject: "You hit Medicare's adherence target",
    headline: "Adherence target reached",
    body:
      "Your last 30 nights show " +
      (pct != null ? `${pct}% of nights` : "more than 70% of nights") +
      " over 4 hours of use — that's the Medicare adherence target. " +
      "Most patients never reach it. You did. Keep going.",
  };
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

export async function sendTherapyMilestoneEmail(
  input: SendTherapyMilestoneEmailInput,
): Promise<SendTherapyMilestoneEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const c = copyFor(input.kind, input.metrics);
  const base = publicBaseUrl(input.baseUrlOverride);
  const therapyUrl = `${base}/account#therapy`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    c.body,
    "",
    `See your therapy summary: ${therapyUrl}`,
    "",
    "Sleep well,",
    "The PennPaps team",
  ].join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:24px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">Milestone</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:600;">${escapeHtml(c.headline)}</h1>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#3c4458;">
            ${escapeHtml(c.body)}
          </p>
          <a href="${escapeHtml(therapyUrl)}" style="display:inline-block;background:#0f1d3a;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-size:14px;font-weight:600;">See your therapy summary</a>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          Sleep well, the PennPaps team
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
      customArgs: {
        kind: "therapy_milestone",
        milestone: input.kind,
      },
    });
    return {
      configured: true,
      delivered: true,
      messageId: result.messageId,
    };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: err.message,
      };
    }
    throw err;
  }
}
