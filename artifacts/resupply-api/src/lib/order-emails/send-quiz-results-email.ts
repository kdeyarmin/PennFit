// sendQuizResultsEmail — transactional email sent when a sleep
// apnea quiz taker requests their results.
//
// Why a transactional email (not marketing)
// -----------------------------------------
// The patient explicitly typed their email and clicked "email me my
// results." Under CAN-SPAM and GDPR's transactional carve-outs, this
// is a requested document delivery, not promotional outreach — so
// it doesn't require a marketing opt-in. Any future follow-up drip
// DOES require the opt-in (carried on the fitter_leads row via
// marketing_opt_in).
//
// The email is intentionally educational, not salesy: the patient
// just took a self-triage and the most useful next step for them
// is to share the result with a physician. We mention PennPaps only
// in the footer + the optional "if you've already been prescribed
// CPAP, here's how we can help" tail.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

const DEFAULT_BASE_URL = "https://pennpaps.com";

export type QuizRiskBand = "low" | "intermediate" | "high";

export interface SendQuizResultsEmailInput {
  toEmail: string;
  /** STOP-BANG score 0..8. */
  score: number;
  band: QuizRiskBand;
  /**
   * The specific symptom keys the patient answered "yes" to. The
   * server doesn't normalize or interpret these — it just lists them
   * back as plain bullets so the patient can show the email to
   * their physician. Capped at 20 entries to bound email size.
   */
  symptoms?: string[];
  baseUrlOverride?: string;
}

export interface SendQuizResultsEmailResult {
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

interface BandCopy {
  subject: string;
  headline: string;
  body: string;
}

function copyForBand(band: QuizRiskBand, score: number): BandCopy {
  if (band === "low") {
    return {
      subject: `Your sleep apnea quiz results: ${score}/8 (lower risk)`,
      headline: "Lower likelihood of moderate-to-severe sleep apnea",
      body:
        "Most people who score in this range don't have moderate-to-severe sleep apnea — but if you're still tired during the day or your bed partner notices anything unusual, it's worth a quick conversation with your primary care doctor.",
    };
  }
  if (band === "intermediate") {
    return {
      subject: `Your sleep apnea quiz results: ${score}/8 (intermediate risk)`,
      headline: "Intermediate risk — worth a physician conversation",
      body:
        "A score in this range is worth flagging with your primary care doctor. Many insurers cover at-home sleep testing, which is far less involved than a sleep lab study.",
    };
  }
  return {
    subject: `Your sleep apnea quiz results: ${score}/8 (higher risk)`,
    headline: "Higher risk — please schedule a physician visit",
    body:
      "A score in this range is strongly associated with moderate-to-severe sleep apnea. Untreated sleep apnea is a real cardiovascular risk; we encourage you to bring this score to your primary care doctor or a sleep medicine specialist.",
  };
}

export async function sendQuizResultsEmail(
  input: SendQuizResultsEmailInput,
): Promise<SendQuizResultsEmailResult> {
  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const copy = copyForBand(input.band, input.score);
  const base = publicBaseUrl(input.baseUrlOverride);
  const learnUrl = `${base}/learn`;
  const insuranceUrl = `${base}/insurance`;

  const symptomsText =
    (input.symptoms ?? []).length > 0
      ? "Yes answers you can share with your physician:\n" +
        (input.symptoms ?? [])
          .slice(0, 20)
          .map((s) => `  • ${s}`)
          .join("\n") +
        "\n"
      : "";

  const symptomsHtml =
    (input.symptoms ?? []).length > 0
      ? `<div style="margin-top:18px;padding:14px 16px;border-radius:8px;background:#f8f9fb;">
           <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a1f36;">Yes answers you can share with your physician</p>
           <ul style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.55;color:#3c4458;">
             ${(input.symptoms ?? [])
               .slice(0, 20)
               .map((s) => `<li>${escapeHtml(s)}</li>`)
               .join("")}
           </ul>
         </div>`
      : "";

  const text = [
    "Hi,",
    "",
    `You scored ${input.score} out of 8 on the STOP-BANG sleep apnea screening.`,
    "",
    copy.body,
    "",
    symptomsText,
    "What to bring up at that visit:",
    `  • Your STOP-BANG score (${input.score}/8) and which symptoms you said "yes" to.`,
    "  • Anything a bed partner has noticed — snoring, gasping, pauses, restless sleep.",
    "  • Ask about at-home sleep testing — most insurers cover it.",
    "  • Any history of high blood pressure, type-2 diabetes, atrial fibrillation, or recent unexplained weight gain.",
    "",
    "This quiz is a screening tool. It is NOT a diagnosis.",
    "",
    `Learn more: ${learnUrl}`,
    `Check insurance coverage if you're prescribed CPAP: ${insuranceUrl}`,
    "",
    "—The PennPaps team",
  ]
    .filter((l) => l !== "")
    .concat([""])
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1f36;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="background:#0f1d3a;color:#ffffff;padding:24px 28px;">
          <p style="margin:0;font-size:12px;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em;">Your STOP-BANG results</p>
          <h1 style="margin:6px 0 0;font-size:22px;font-weight:600;">${escapeHtml(copy.headline)}</h1>
          <p style="margin:6px 0 0;font-size:14px;opacity:0.85;">Score: ${input.score}/8</p>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.55;color:#3c4458;">${escapeHtml(copy.body)}</p>
          ${symptomsHtml}
          <div style="margin-top:18px;padding:14px 16px;border-radius:8px;background:#0f1d3a08;">
            <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#1a1f36;">What to bring up at that visit</p>
            <ul style="margin:0;padding:0 0 0 18px;font-size:13px;line-height:1.55;color:#3c4458;">
              <li>Your STOP-BANG score (${input.score}/8) and which symptoms you said &ldquo;yes&rdquo; to.</li>
              <li>Anything a bed partner has noticed &mdash; snoring, gasping, pauses, restless sleep.</li>
              <li>Ask about <strong>at-home sleep testing</strong> &mdash; most insurers cover it.</li>
              <li>Any history of high blood pressure, type-2 diabetes, atrial fibrillation, or recent unexplained weight gain.</li>
            </ul>
          </div>
          <p style="margin:18px 0 0;font-size:12px;color:#8b95a9;font-style:italic;">This quiz is a screening tool. It is NOT a diagnosis.</p>
        </td></tr>
        <tr><td style="padding:16px 28px 24px;border-top:1px solid #eef0f5;font-size:12px;color:#8b95a9;">
          <a href="${escapeHtml(learnUrl)}" style="color:#0f1d3a;text-decoration:none;">Learn more about sleep apnea</a> &nbsp;·&nbsp;
          <a href="${escapeHtml(insuranceUrl)}" style="color:#0f1d3a;text-decoration:none;">Insurance coverage</a><br/>
          The PennPaps team
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const result = await client.sendEmail({
      to: input.toEmail,
      subject: copy.subject,
      text,
      html,
      customArgs: {
        kind: "sleep_apnea_quiz_results",
        band: input.band,
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
