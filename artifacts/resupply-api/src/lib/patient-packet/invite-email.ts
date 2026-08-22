// Pure renderers for the patient-facing new-patient-packet invitation.
//
// Extracted from `send.ts` so the copy has ONE home that can be rendered
// without pulling that module's Supabase / SendGrid / Twilio dependency
// tree along with it. `send.ts` still owns delivery; this module owns
// only what the patient reads.
//
// The message-preview catalog renders the invite by calling these same
// functions, so the preview staff see is byte-for-byte the email that
// goes out — it cannot drift.

import {
  escapeHtml,
  paragraph,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

export function renderPacketInviteHtml(
  company: string,
  recipientName: string,
  link: string,
): string {
  // `company` goes into slots the layout escapes itself — pass it raw or
  // it double-escapes. Only `safeName` is pre-escaped, because it lands in
  // `paragraph()`, which injects its argument verbatim.
  const safeName = escapeHtml(recipientName);
  // Chrome comes from the shared CareMetric Breathe email design system.
  return renderBrandedEmail({
    brandName: company,
    heading: "Review and sign your documents",
    preheader:
      "Please review and electronically sign your new patient documents.",
    contentHtml: [
      paragraph(`Hello ${safeName},`),
      textParagraph(
        "Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any phone, tablet, or computer.",
      ),
    ].join("\n"),
    button: { label: "Review & sign my documents", url: link },
    footerLines: [
      `If the button doesn't work, copy and paste this link into your browser: ${link}`,
      "This is a secure, personalized link. Please don't forward it. If you didn't expect this message, you can ignore it.",
    ],
    copyrightName: company,
  });
}

export function renderPacketInviteText(
  company: string,
  recipientName: string,
  link: string,
): string {
  return [
    `${company}`,
    "",
    `Hello ${recipientName},`,
    "",
    "Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any device.",
    "",
    `Review & sign: ${link}`,
    "",
    "This is a secure, personalized link. Please don't forward it.",
  ].join("\n");
}
