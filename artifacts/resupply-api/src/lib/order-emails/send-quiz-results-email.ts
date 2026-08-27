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
// is to share the result with a physician. We mention Penn Home Medical Supply only
// in the footer + the optional "if you've already been prescribed
// CPAP, here's how we can help" tail.

import {
  EmailApiError,
  EmailConfigError,
  BREATHE_COLORS,
  bulletList,
  escapeHtml,
  infoPanel,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { resolveBrandingByOrgId } from "../tenant-branding.js";
import {
  resolvePatientEmailLinkBase,
  TENANT_DOMAIN_REQUIRED,
} from "./link-base.js";

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
  /**
   * Tenant the quiz lead belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendQuizResultsEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
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
      body: "Most people who score in this range don't have moderate-to-severe sleep apnea — but if you're still tired during the day or your bed partner notices anything unusual, it's worth a quick conversation with your primary care doctor.",
    };
  }
  if (band === "intermediate") {
    return {
      subject: `Your sleep apnea quiz results: ${score}/8 (intermediate risk)`,
      headline: "Intermediate risk — worth a physician conversation",
      body: "A score in this range is worth flagging with your primary care doctor. Many insurers cover at-home sleep testing, which is far less involved than a sleep lab study.",
    };
  }
  return {
    subject: `Your sleep apnea quiz results: ${score}/8 (higher risk)`,
    headline: "Higher risk — please schedule a physician visit",
    body: "A score in this range is strongly associated with moderate-to-severe sleep apnea. Untreated sleep apnea is a real cardiovascular risk; we encourage you to bring this score to your primary care doctor or a sleep medicine specialist.",
  };
}

export async function sendQuizResultsEmail(
  input: SendQuizResultsEmailInput,
): Promise<SendQuizResultsEmailResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const copy = copyForBand(input.band, input.score);
  const base = await resolvePatientEmailLinkBase(
    input.orgId,
    input.baseUrlOverride,
  );
  if (!base) {
    return {
      configured: true,
      delivered: false,
      error: TENANT_DOMAIN_REQUIRED,
    };
  }
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
      ? infoPanel({
          title: "Yes answers you can share with your physician",
          html: bulletList((input.symptoms ?? []).slice(0, 20)),
        })
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
    `—The ${brandName} team`,
  ]
    .filter((l) => l !== "")
    .concat([""])
    .join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const html = renderBrandedEmail({
    brandName,
    brandTagline: "Your STOP-BANG results",
    heading: copy.headline,
    preheader: `Score: ${input.score}/8. ${copy.body}`,
    contentHtml: [
      paragraph(`<strong>Score: ${input.score}/8</strong>`),
      textParagraph(copy.body),
      symptomsHtml,
      infoPanel({
        title: "What to bring up at that visit",
        html: `<ul style="margin:0;padding-left:20px;">
<li style="margin:0 0 6px;">Your STOP-BANG score (${input.score}/8) and which symptoms you said &ldquo;yes&rdquo; to.</li>
<li style="margin:0 0 6px;">Anything a bed partner has noticed &mdash; snoring, gasping, pauses, restless sleep.</li>
<li style="margin:0 0 6px;">Ask about <strong>at-home sleep testing</strong> &mdash; most insurers cover it.</li>
<li style="margin:0;">Any history of high blood pressure, type-2 diabetes, atrial fibrillation, or recent unexplained weight gain.</li>
</ul>`,
      }),
      `<p style="margin:18px 0 0;color:${BREATHE_COLORS.muted};font-size:12px;font-style:italic;">This quiz is a screening tool. It is NOT a diagnosis.</p>`,
    ].join("\n"),
    footerHtml: `<a href="${escapeHtml(learnUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Learn more about sleep apnea</a> &nbsp;·&nbsp; <a href="${escapeHtml(insuranceUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Insurance coverage</a>`,
    footerLines: [`The ${brandName} team`],
    copyrightName: brandName,
  });

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
