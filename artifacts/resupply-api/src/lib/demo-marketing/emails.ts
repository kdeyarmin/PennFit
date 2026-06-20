// Demo-lead nurture email copy — the CareMetric Breathe marketing drip.
//
// When a visitor opens the self-serve product demo on the Breathe
// marketing site they volunteer their email (POST /demo-lead →
// public.newsletter_subscribers, source='breathe-demo'). The demo-drip
// worker walks them through this short, branded sequence:
//
//   stage 0 → welcome           (sent on the first tick after signup)
//   stage 1 → "what to explore" (≈2 days later)
//   stage 2 → "ready to talk?"  (≈3 days after that)
//
// All three are PLATFORM emails: the brand is CareMetric Breathe (not a
// tenant), they go out under the platform's own SendGrid sender, and
// every one carries a one-click unsubscribe link (CAN-SPAM). The shared
// branded layout lives in @workspace/resupply-email/layout so these read
// as the same brand as the transactional mail and the marketing site.
//
// PHI: none — a volunteered marketing address with no clinical linkage.

import {
  PLATFORM_BRAND_NAME,
  paragraph,
  renderBrandedEmail,
} from "@workspace/resupply-email/layout";

export interface DemoEmail {
  subject: string;
  html: string;
  text: string;
}

/** Links the copy points at. Resolved once by the worker so the drip can
 *  be pointed at any environment's host. */
export interface DemoEmailLinks {
  /** Where "open the demo" lands — the platform's `/admin?demo=1` gate. */
  demoUrl: string;
  /** Marketing features deep-dive page. */
  featuresUrl: string;
  /** Where "talk to us" goes — a mailto: or contact URL. */
  contactUrl: string;
  /** One-click unsubscribe URL bound to this lead's email. */
  unsubscribeUrl: string;
}

const SIGNOFF = "— The CareMetric Breathe team";
const FOOTER_NOTE =
  "You're receiving this because you opened the CareMetric Breathe demo.";

function unsubscribeFooterHtml(unsubscribeUrl: string): string {
  const safe = unsubscribeUrl.replace(/"/g, "&quot;");
  return `<a href="${safe}" style="color:#9aa6be;text-decoration:underline;">Unsubscribe</a> · CareMetric Breathe · cmbreathe.com`;
}

function wrap(opts: {
  heading: string;
  preheader: string;
  bodyHtml: string;
  button: { label: string; url: string };
  unsubscribeUrl: string;
}): string {
  return renderBrandedEmail({
    brandName: PLATFORM_BRAND_NAME,
    brandTagline: "Resupply, automated",
    heading: opts.heading,
    preheader: opts.preheader,
    contentHtml: opts.bodyHtml,
    button: opts.button,
    footerLines: [FOOTER_NOTE],
    footerHtml: unsubscribeFooterHtml(opts.unsubscribeUrl),
  });
}

/** stage 0 → welcome. Sent on the first drip tick after a lead opens the
 *  demo. Confirms the sandbox is theirs to explore and points them back
 *  in, in case they bounced before clicking around. */
export function renderDemoWelcomeEmail(links: DemoEmailLinks): DemoEmail {
  const subject = "Welcome to your CareMetric Breathe demo";
  const html = wrap({
    heading: "Your demo is ready to explore",
    preheader:
      "Step inside the CareMetric Breathe command center — sample data, no setup.",
    button: { label: "Open the live demo", url: links.demoUrl },
    unsubscribeUrl: links.unsubscribeUrl,
    bodyHtml: `${paragraph(
      "Thanks for taking CareMetric Breathe for a spin. The demo is a fully interactive command center loaded with sample patients, orders, and resupply schedules — poke at anything, nothing is real and nothing breaks.",
    )}${paragraph("A few things worth trying first:")}
<ul style="margin:0 0 16px;padding-left:20px;color:#334155;font-size:16px;line-height:1.7;">
<li>Open the <strong>resupply worklist</strong> and watch the reminder engine flag who's due.</li>
<li>Drop into a <strong>patient record</strong> to see orders, therapy data, and messages in one place.</li>
<li>Ask <strong>CareMetric Copilot</strong>, the admin assistant, how something works.</li>
</ul>
${paragraph(
  "It picks up right where you left off — jump back in whenever you have a minute.",
)}${paragraph(SIGNOFF)}`,
  });
  const text = `Welcome to your CareMetric Breathe demo

Thanks for taking CareMetric Breathe for a spin. The demo is a fully interactive command center loaded with sample patients, orders, and resupply schedules — poke at anything, nothing is real and nothing breaks.

A few things worth trying first:
  * Open the resupply worklist and watch the reminder engine flag who's due.
  * Drop into a patient record to see orders, therapy data, and messages in one place.
  * Ask CareMetric Copilot, the admin assistant, how something works.

Open the live demo: ${links.demoUrl}

It picks up right where you left off — jump back in whenever you have a minute.

${SIGNOFF}

${FOOTER_NOTE}
Unsubscribe: ${links.unsubscribeUrl}`;
  return { subject, html, text };
}

/** stage 1 → "what to explore". A couple of days on: go deeper on the
 *  capabilities that separate the platform, with a path to the features
 *  page for the full picture. */
export function renderDemoFollowupOneEmail(links: DemoEmailLinks): DemoEmail {
  const subject = "The features doing the heavy lifting in Breathe";
  const html = wrap({
    heading: "What's running under the hood",
    preheader:
      "Automated resupply reminders, an AI front desk, and billing that reconciles itself.",
    button: { label: "See all the features", url: links.featuresUrl },
    unsubscribeUrl: links.unsubscribeUrl,
    bodyHtml: `${paragraph(
      "Hope you had a chance to look around. Behind the friendly screens, CareMetric Breathe is doing the work a resupply coordinator would otherwise do by hand:",
    )}
<ul style="margin:0 0 16px;padding-left:20px;color:#334155;font-size:16px;line-height:1.7;">
<li><strong>Resupply reminders that escalate</strong> — SMS, voice, and email touches that know when to stop.</li>
<li><strong>An AI front desk</strong> — the chatbot and voice agent handle routine patient questions around the clock.</li>
<li><strong>Therapy-cloud sync</strong> — ResMed, Philips, and 3B compliance data pulled in nightly.</li>
<li><strong>Billing that reconciles</strong> — claims, EOBs, and PacWare exports without the spreadsheet gymnastics.</li>
</ul>
${paragraph(
  "Want the full tour? The features page breaks down every piece.",
)}${paragraph(SIGNOFF)}`,
  });
  const text = `The features doing the heavy lifting in Breathe

Hope you had a chance to look around. Behind the friendly screens, CareMetric Breathe is doing the work a resupply coordinator would otherwise do by hand:

  * Resupply reminders that escalate — SMS, voice, and email touches that know when to stop.
  * An AI front desk — the chatbot and voice agent handle routine patient questions around the clock.
  * Therapy-cloud sync — ResMed, Philips, and 3B compliance data pulled in nightly.
  * Billing that reconciles — claims, EOBs, and PacWare exports without the spreadsheet gymnastics.

See all the features: ${links.featuresUrl}

${SIGNOFF}

${FOOTER_NOTE}
Unsubscribe: ${links.unsubscribeUrl}`;
  return { subject, html, text };
}

/** stage 2 → "ready to talk?". The conversion ask: see it with your own
 *  patients. Soft, low-pressure, with a direct line to a human. */
export function renderDemoFollowupTwoEmail(links: DemoEmailLinks): DemoEmail {
  const subject = "Ready to see Breathe with your own patients?";
  const html = wrap({
    heading: "Let's make it real",
    preheader:
      "A 20-minute walkthrough with your own workflow — no slide deck.",
    button: { label: "Book a walkthrough", url: links.contactUrl },
    unsubscribeUrl: links.unsubscribeUrl,
    bodyHtml: `${paragraph(
      "The sample data is great for kicking the tires — but the real moment is seeing CareMetric Breathe run against your own resupply workflow.",
    )}${paragraph(
      "We'll set up a short, no-pressure walkthrough: bring the parts of your day that take the most time, and we'll show you exactly how the platform handles them. Twenty minutes, no slide deck.",
    )}${paragraph(
      "Just reply to this email or use the button below, and we'll find a time.",
    )}${paragraph(SIGNOFF)}`,
  });
  const text = `Ready to see Breathe with your own patients?

The sample data is great for kicking the tires — but the real moment is seeing CareMetric Breathe run against your own resupply workflow.

We'll set up a short, no-pressure walkthrough: bring the parts of your day that take the most time, and we'll show you exactly how the platform handles them. Twenty minutes, no slide deck.

Just reply to this email or use the link below, and we'll find a time.

Book a walkthrough: ${links.contactUrl}

${SIGNOFF}

${FOOTER_NOTE}
Unsubscribe: ${links.unsubscribeUrl}`;
  return { subject, html, text };
}

/** The drip stages in send order. Index === the `demo_drip_stage` value
 *  that is DUE for this email (0=welcome, 1=followup-1, 2=followup-2). */
export const DEMO_DRIP_EMAILS: ReadonlyArray<
  (links: DemoEmailLinks) => DemoEmail
> = [
  renderDemoWelcomeEmail,
  renderDemoFollowupOneEmail,
  renderDemoFollowupTwoEmail,
];
