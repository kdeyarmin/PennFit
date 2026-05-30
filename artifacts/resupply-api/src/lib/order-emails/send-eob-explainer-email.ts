// sendEobExplainerEmail — patient-facing explainer when an EOB
// (Explanation of Benefits) event posts to one of their insurance
// claims.
//
// Why
// ---
// Patients open an EOB from the payer and don't understand any of
// it. "Allowed amount? Coinsurance? Adjustment?" Then they call us.
// Pre-empting that call with our own plain-language explainer is the
// single biggest billing-question deflection in DME, with the side
// benefit of building trust that we're not hiding the math.
//
// Fired from POST /patients/:id/insurance-claims/:claimId/events
// when the event_type is one of:
//
//   * 'paid'         — claim is fully paid; explain what was billed,
//                      what insurance covered, and what the patient
//                      owes.
//   * 'partial_pay'  — explain the gap.
//   * 'denied'       — explain why and what the next steps are
//                      (appeal / patient pays / write-off).
//
// Best-effort: a SendGrid outage must not 500 the event POST. The
// route catches and logs.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type EobEventKind = "paid" | "partial_pay" | "denied";

export interface SendEobExplainerEmailInput {
  toEmail: string;
  firstName?: string | null;
  kind: EobEventKind;
  payerName: string;
  claimNumber?: string | null;
  dateOfService: string;
  totals: {
    billedCents: number;
    allowedCents: number;
    paidCents: number;
    patientResponsibilityCents: number;
  };
  denialReason?: string | null;
  baseUrlOverride?: string;
}

export interface SendEobExplainerEmailResult {
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

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function subjectFor(kind: EobEventKind): string {
  if (kind === "paid")
    return "Insurance paid your claim — here's the breakdown";
  if (kind === "partial_pay") return "Update on your insurance claim";
  return "Your insurance claim was denied — next steps";
}

function leadFor(kind: EobEventKind, payerName: string): string {
  if (kind === "paid") {
    return `${payerName} processed your claim and paid their portion. Here's the breakdown so the EOB they mail you isn't a puzzle.`;
  }
  if (kind === "partial_pay") {
    return `${payerName} processed your claim and paid part of it. The remaining balance is your responsibility under your plan.`;
  }
  return `${payerName} denied your claim. We don't bill you yet — there are usually next steps that can change that outcome.`;
}

export async function sendEobExplainerEmail(
  input: SendEobExplainerEmailInput,
): Promise<SendEobExplainerEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const base = publicBaseUrl(input.baseUrlOverride);
  const accountUrl = `${base}/account`;
  const supportUrl = `${base}/account#chat`;
  const greeting = input.firstName
    ? `Hi ${escapeHtml(input.firstName)},`
    : "Hi there,";
  const subject = subjectFor(input.kind);
  const lead = leadFor(input.kind, input.payerName);

  const t = input.totals;
  const breakdownRows = [
    { label: "We billed your insurance", value: fmtMoney(t.billedCents) },
    {
      label: "Your plan's allowed amount",
      value: fmtMoney(t.allowedCents),
    },
    { label: "Insurance paid", value: fmtMoney(t.paidCents) },
    {
      label: "Your responsibility",
      value: fmtMoney(t.patientResponsibilityCents),
    },
  ];

  const dosLine = `Date of service: ${input.dateOfService}${
    input.claimNumber ? ` · Claim #${input.claimNumber}` : ""
  }`;

  const text = [
    input.firstName ? `Hi ${input.firstName},` : "Hi there,",
    "",
    lead,
    "",
    dosLine,
    "",
    ...breakdownRows.map((r) => `${r.label}: ${r.value}`),
    "",
    input.kind === "denied" && input.denialReason
      ? `Denial reason: ${input.denialReason}`
      : null,
    input.kind === "denied"
      ? "We'll review the denial and let you know what we can do next — file an appeal, gather more documentation, or work out a path forward together. You don't need to take action yet."
      : null,
    "",
    "Questions about this? Open a chat from your account or reply to this email.",
    "",
    `View on your account: ${accountUrl}`,
    "",
    "—The PennPaps billing team",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const rowsHtml = breakdownRows
    .map(
      (r) =>
        `<tr><td style="padding:6px 8px;color:#5a6478;font-size:14px;">${escapeHtml(r.label)}</td><td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;font-size:14px;font-weight:600;color:#1a1f36;">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");

  const denialBlock =
    input.kind === "denied"
      ? `
        ${input.denialReason ? `<p style="margin:16px 0 0;font-size:13px;color:#5a6478;"><strong>Denial reason:</strong> ${escapeHtml(input.denialReason)}</p>` : ""}
        <p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#3c4458;">
          We&apos;ll review the denial and let you know what we can do next — file an appeal, gather more documentation, or work out a path forward together. <strong>You don&apos;t need to take action yet.</strong>
        </p>`
      : "";

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:20px 28px;">
          <h1 style="margin:0;font-size:20px;font-weight:600;">${escapeHtml(subject)}</h1>
          <p style="margin:4px 0 0;font-size:13px;opacity:0.85;">${escapeHtml(dosLine)}</p>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 12px;font-size:15px;line-height:1.5;">${greeting}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.55;color:#3c4458;">${escapeHtml(lead)}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border:1px solid #eef0f5;border-radius:8px;border-collapse:separate;border-spacing:0;">
            ${rowsHtml}
          </table>
          ${denialBlock}
          <p style="margin:20px 0 8px;font-size:13px;color:#5a6478;">
            Questions about this? <a href="${escapeHtml(supportUrl)}" style="color:#0f1d3a;">Open a chat</a> or reply to this email — we&apos;ll get you a human.
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          <a href="${escapeHtml(accountUrl)}" style="color:#0f1d3a;text-decoration:none;">View on your account</a> &nbsp;·&nbsp;
          The PennPaps billing team
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject,
      text,
      html,
      customArgs: {
        kind: "eob_explainer",
        event: input.kind,
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
