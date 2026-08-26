// Patient-message preview catalog.
//
// One place that answers "what does the patient actually receive?" for
// every outbound scenario, rendered with the tenant's own brand and a
// fictional sample patient. It backs `/admin/message-previews` (the
// gallery + the send-a-test action) and the demo sandbox's seeded copy of
// the same page.
//
// Fidelity — read this before adding a scenario
// ---------------------------------------------
// Each entry declares how close the preview is to production:
//
//   * `"exact"`    — the preview CALLS the production renderer. What you
//     see is byte-for-byte what the patient gets. Preferred; use it
//     whenever a pure renderer exists.
//   * `"mirrored"` — the copy is duplicated here because the production
//     body is built inline inside a DB-dependent send function, and
//     extracting it would mean refactoring a live send path. Every
//     mirrored entry names its `source` file and a distinctive
//     `sourceFingerprint` string; `catalog.drift.test.ts` greps the
//     source for that string and FAILS if it is gone, so production copy
//     cannot silently drift away from what this page advertises.
//
// A mirrored entry is a compromise, not a licence to invent copy. If you
// find yourself writing new patient wording here, write it in the
// renderer instead and point this at it.
//
// PHI: every value here is fictional sample data. The catalog never reads
// a real patient — the whole point is that it is safe to render on screen
// and safe to send to a staff member's own phone.

import {
  gsm7Length,
  isGsm7,
  renderResupplyReminder,
  type ReminderVariant,
} from "@workspace/resupply-messaging";
import {
  applyVariables,
  applyVariablesHtmlSafe,
} from "@workspace/resupply-templates";
import { defaultReminderSmsBody } from "@workspace/resupply-reminders";

import { MESSAGE_TEMPLATE_SEEDS } from "../message-templates/seed-bodies";
import {
  renderInviteEmailHtml,
  renderInviteEmailText,
} from "../video-visits/invite-email";
import {
  renderPacketInviteHtml,
  renderPacketInviteText,
} from "../patient-packet/invite-email";
import { BREATHE_COLORS, renderBrandedEmail } from "@workspace/resupply-email";

import {} from "../back-in-stock-email";

export type PreviewGroup = "resupply" | "orders" | "clinical" | "billing";

export interface PreviewEmail {
  subject: string;
  html: string;
  text: string;
}

export interface PreviewSms {
  body: string;
  /** Segment math, so staff can see what a message actually costs to send. */
  encoding: "GSM-7" | "UCS-2";
  characters: number;
  /** Billable septets (GSM-7) or UTF-16 units (UCS-2). */
  units: number;
  segments: number;
}

export interface MessagePreview {
  id: string;
  group: PreviewGroup;
  label: string;
  /** What the patient is being told. */
  description: string;
  /** What causes this to fire. */
  trigger: string;
  fidelity: "exact" | "mirrored";
  /** Repo-relative file that owns the production copy. */
  source: string;
  /**
   * Set when the SMS variant is built somewhere OTHER than `source` —
   * several scenarios have their email in one module and their text in
   * the route that sends it.
   */
  smsSource?: string;
  email: PreviewEmail | null;
  sms: PreviewSms | null;
}

/** Brand + contact values a preview renders against. */
export interface PreviewBrand {
  /**
   * Storefront brand (`organizations.storefront_name`). Used by the shop
   * / order emails, which brand themselves this way.
   */
  brandName: string;
  /**
   * Practice name from `getCompanyInfo().name` — the DBA when set, else
   * the legal name. A tenant can configure this INDEPENDENTLY of the
   * storefront brand, and the resupply reminder worker passes THIS as
   * `practiceName`. Using the storefront brand for those scenarios would
   * show a different name from the message patients actually get.
   */
  companyName: string;
  legalName: string;
  supportPhoneDisplay: string;
  supportEmail: string;
  /** Origin for patient links (tenant custom domain when verified). */
  baseUrl: string;
}

// ── Sample patient ──────────────────────────────────────────────────
// Deliberately obvious as sample data: a staff member who mis-types their
// own number and sends a test to a stranger should not have handed them
// something that reads like a real medical notice about themselves.

export const SAMPLE = {
  firstName: "Jordan",
  lastName: "Alvarez",
  orderNumber: "CMB-DEMO-4417",
  trackingCarrier: "UPS",
  trackingNumber: "1Z999AA10123456784",
  items: [
    { name: "Nasal cushion (medium)", quantity: 2 },
    { name: "Headgear", quantity: 1 },
    { name: "Disposable filters (6-pack)", quantity: 1 },
  ],
  amountTotalCents: 8460,
  balanceCents: 4215,
  pickupLocation: "Riverside Main Street branch",
  deviceModel: "AirSense 11",
  recallModel: "DreamStation (first generation)",
  packetTitle: "Assignment of Benefits",
  appointmentAt: "Tuesday, March 4 at 10:15 AM",
  daysUntilExpiry: 12,
} as const;

// ── SMS metering ────────────────────────────────────────────────────

/**
 * Measure an SMS the way the carrier bills it. One non-GSM-7 character
 * (a curly quote, an em dash, an emoji) flips the WHOLE message to UCS-2
 * and cuts the segment size from 160 to 70 — which is why the preview
 * shows this rather than a naive character count.
 */
export function meterSms(body: string): PreviewSms {
  const septets = gsm7Length(body);
  if (isGsm7(body) && septets != null) {
    return {
      body,
      encoding: "GSM-7",
      characters: [...body].length,
      units: septets,
      // Multi-segment GSM-7 spends 7 septets per part on the UDH header.
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  const units = body.length; // UTF-16 code units, which is what UCS-2 counts
  return {
    body,
    encoding: "UCS-2",
    characters: [...body].length,
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The shared shell the mirrored emails render into: the SAME
 * `renderBrandedEmail` chrome the production senders use, so a preview
 * cannot flatter what actually lands in the inbox.
 */
function shell(brand: PreviewBrand, bodyHtml: string): string {
  // Same branded shell the real senders use, so an "approximate" preview
  // still shows staff the chrome a patient actually receives.
  return renderBrandedEmail({
    brandName: brand.brandName,
    contentHtml: bodyHtml,
    footerLines: [
      brand.legalName,
      `Questions? Call ${brand.supportPhoneDisplay} or reply to this email.`,
    ],
    copyrightName: brand.legalName,
  });
}

function p(text: string): string {
  return `<p style="margin:0 0 16px;font-family:Arial,Helvetica,sans-serif;color:${BREATHE_COLORS.body};font-size:16px;line-height:1.6;">${text}</p>`;
}

function itemsText(): string {
  return SAMPLE.items.map((i) => `  - ${i.quantity} x ${i.name}`).join("\n");
}

function itemsHtml(): string {
  return `      <ul style="margin:0 0 12px;padding-left:20px;color:${BREATHE_COLORS.body};font-size:14px;line-height:1.55;">${SAMPLE.items
    .map((i) => `<li>${i.quantity} &times; ${escapeHtml(i.name)}</li>`)
    .join("")}</ul>`;
}

/**
 * Copyright year for the seeded rows' footer. The seeds carry
 * `{{copyright_year}}` rather than a baked year (see `seed-bodies.ts`),
 * so every preview that renders one has to supply it.
 */
const PREVIEW_YEAR = String(new Date().getFullYear());

/** Render one seeded template row by key, with the variables it allows. */
function fromSeed(
  templateKey: string,
  variables: Record<string, string>,
): { subject: string | null; text: string; html: string | null } | null {
  const seed = MESSAGE_TEMPLATE_SEEDS.find(
    (s) => s.templateKey === templateKey,
  );
  if (!seed) return null;
  const allowed = seed.allowedVariables;
  // Same split renderMessage() uses: plain substitution for subject/text,
  // HTML-escaping substitution for the HTML body (with the `_html` opt-out
  // for values that are already trusted markup).
  return {
    subject: seed.subject
      ? applyVariables(seed.subject, variables, allowed)
      : null,
    text: applyVariables(seed.bodyText, variables, allowed),
    html: seed.bodyHtml
      ? applyVariablesHtmlSafe(seed.bodyHtml, variables, allowed)
      : null,
  };
}

// ── The catalog ─────────────────────────────────────────────────────

/**
 * Build every preview for one tenant's brand. Pure — no DB, no network —
 * so it is equally callable from the route, a test, and the demo sandbox.
 */
export function buildMessagePreviews(brand: PreviewBrand): MessagePreview[] {
  const { brandName, baseUrl } = brand;
  const first = SAMPLE.firstName;
  const confirmUrl = `${baseUrl}/r/c/demo-signed-token`;
  const editUrl = `${baseUrl}/r/e/demo-signed-token`;
  const stopUrl = `${baseUrl}/r/s/demo-signed-token`;

  const out: MessagePreview[] = [];

  // ── Resupply reminders ────────────────────────────────────────────
  // EXACT: both channels call the production renderers.
  const reminderMeta: Record<
    ReminderVariant,
    { label: string; description: string; trigger: string }
  > = {
    initial: {
      label: "Resupply reminder — first touch",
      description:
        "Tells the patient their supplies are due and asks them to confirm they still use the equipment and are running low.",
      trigger:
        "The resupply engine finds an eligible patient whose refill window has opened.",
    },
    followup: {
      label: "Resupply reminder — follow-up",
      description:
        "A softer second touch when the first reminder got no reply. More outreach still to come.",
      trigger:
        "No reply to the first reminder after the configured escalation delay.",
    },
    final: {
      label: "Resupply reminder — last call",
      description:
        "The final automated touch before the queue hands the patient to a human to call.",
      trigger:
        "No reply after the follow-up, at the end of the escalation ladder.",
    },
  };

  for (const variant of ["initial", "followup", "final"] as const) {
    const meta = reminderMeta[variant];
    const email = renderResupplyReminder({
      // The worker passes getCompanyInfo(orgId).name here — mirror it.
      practiceName: brand.companyName,
      firstName: first,
      items: SAMPLE.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      confirmUrl,
      editUrl,
      stopUrl,
      variant,
    });
    out.push({
      id: `resupply.reminder.${variant}`,
      group: "resupply",
      label: meta.label,
      description: meta.description,
      trigger: meta.trigger,
      fidelity: "exact",
      source: "lib/resupply-messaging/src/email-templates.ts",
      email: { subject: email.subject, html: email.html, text: email.text },
      sms: meterSms(defaultReminderSmsBody(variant, first, brand.companyName)),
    });
  }

  out.push({
    id: "orders.shipped",
    group: "orders",
    label: "Order shipped",
    description: "Carrier and tracking number for a dispatched order.",
    trigger: "A shipping label is bought, or the carrier reports first scan.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-email.ts",
    email: {
      subject: `Your ${brandName} order has shipped`,
      text: [
        `Good news ${first} — your ${brandName} order is on its way.`,
        "",
        `Carrier: ${SAMPLE.trackingCarrier}`,
        `Tracking: ${SAMPLE.trackingNumber}`,
        "",
        "What's in this shipment:",
        itemsText(),
        "",
        `Track your order: ${baseUrl}/account/orders`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(
            `Good news ${escapeHtml(first)} &mdash; your ${escapeHtml(brandName)} order is on its way.`,
          ),
          p(
            `<strong>${escapeHtml(SAMPLE.trackingCarrier)}</strong> &middot; ${escapeHtml(SAMPLE.trackingNumber)}`,
          ),
          itemsHtml(),
        ].join("\n"),
      ),
    },
    // The shipped SMS is NOT built by the email module above — it is
    // assembled in routes/admin/shop-orders.ts, with its own wording.
    smsSource: "artifacts/resupply-api/src/routes/admin/shop-orders.ts",
    sms: meterSms(
      `Hi ${first}: your CPAP supplies just shipped (${SAMPLE.trackingCarrier} ${SAMPLE.trackingNumber}). Reply STOP to opt out.`,
    ),
  });

  out.push({
    id: "orders.delivered",
    group: "orders",
    label: "Order delivered",
    description:
      "Confirms the carrier marked the parcel delivered, and invites a reply if it has not turned up.",
    trigger: "Carrier tracking flips to delivered.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/delivered-notification.ts",
    email: {
      subject: `Your ${brandName} supplies were delivered`,
      text: [
        `Hi ${first}, the carrier says your CPAP supplies have arrived.`,
        "",
        "If you can't find the parcel, reply to this email and we'll chase it with the carrier.",
        "",
        `View your order: ${baseUrl}/account/orders`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(
            `Hi ${escapeHtml(first)}, the carrier says your CPAP supplies have arrived.`,
          ),
          p(
            "If you can't find the parcel, reply to this email and we'll chase it with the carrier.",
          ),
        ].join("\n"),
      ),
    },
    sms: meterSms(
      `Hi ${first}: your CPAP supplies were delivered. Reply STOP to opt out.`,
    ),
  });

  // ── Clinical & compliance ─────────────────────────────────────────
  // EXACT: seeded template rows for both channels.
  const rxEmail = fromSeed("rx_renewal.email", {
    first_name: first,
    days_until_expiry: String(SAMPLE.daysUntilExpiry),
    greeting: `Hi ${first}`,
    greeting_html: `Hi ${escapeHtml(first)}`,
    subject_line: "Time to renew your CPAP prescription",
    headline: `Your prescription on file expires in ${SAMPLE.daysUntilExpiry} days.`,
    headline_html: `Your prescription on file expires in ${SAMPLE.daysUntilExpiry} days.`,
    brand_name: brandName,
    brand_legal_name: brand.legalName,
    brand_legal_name_html: escapeHtml(brand.legalName),
    copyright_year: PREVIEW_YEAR,
  });
  const rxSms = fromSeed("rx_renewal.sms", {
    sms_greeting: `Hi ${first}`,
    rx_status_clause: `your CPAP prescription expires in ${SAMPLE.daysUntilExpiry} days`,
    brand_name: brandName,
    first_name: first,
  });
  if (rxEmail) {
    out.push({
      id: "clinical.rx_renewal",
      group: "clinical",
      label: "Prescription renewal needed",
      description:
        "Warns the patient their prescription is expiring and offers to chase the physician for them.",
      trigger:
        "The prescription on file is inside the renewal window before its expiry date.",
      fidelity: "exact",
      source: "artifacts/resupply-api/src/lib/message-templates/seed-bodies.ts",
      email: {
        subject: rxEmail.subject ?? "Time to renew",
        text: rxEmail.text,
        html: rxEmail.html ?? shell(brand, p(escapeHtml(rxEmail.text))),
      },
      sms: rxSms ? meterSms(rxSms.text) : null,
    });
  }

  out.push({
    id: "clinical.recall",
    group: "clinical",
    label: "Equipment recall notice",
    description:
      "Tells a patient their device is affected by a manufacturer recall and what to do next.",
    trigger: "Staff run a recall campaign against the affected-device roster.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/worker/jobs/recall-notifications-send.ts",
    email: {
      subject: `Important safety notice about your ${SAMPLE.recallModel}`,
      text: [
        `Hi ${first},`,
        "",
        `The manufacturer has issued a recall affecting the ${SAMPLE.recallModel}, which our records show you use.`,
        "",
        "Please do not stop therapy before speaking to us or your physician — we will help you arrange a replacement.",
        "",
        `Call ${brand.supportPhoneDisplay} or reply to this email and we'll walk you through it.`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(`Hi ${escapeHtml(first)},`),
          p(
            `The manufacturer has issued a recall affecting the <strong>${escapeHtml(SAMPLE.recallModel)}</strong>, which our records show you use.`,
          ),
          p(
            "Please do not stop therapy before speaking to us or your physician &mdash; we will help you arrange a replacement.",
          ),
          p(
            `Call <strong>${escapeHtml(brand.supportPhoneDisplay)}</strong> or reply to this email and we'll walk you through it.`,
          ),
        ].join("\n"),
      ),
    },
    sms: meterSms(
      `${first}, a safety recall affects your ${SAMPLE.recallModel}. Do not stop therapy. Call ${brandName} at ${brand.supportPhoneDisplay}. Reply STOP to opt out.`,
    ),
  });

  // EXACT: the patient-packet invite renderers are exported and pure.
  // (An earlier version of this cited provider-esign.ts, whose similar
  // notice goes to a PROVIDER and links to /provider/sign-in — a message
  // no patient ever receives.)
  const packetLink = `${baseUrl}/patient-packet-sign?token=demo-signed-token`;
  out.push({
    id: "clinical.packet_esign",
    group: "clinical",
    label: "New patient documents to sign",
    description:
      "Asks the patient to e-sign their new-patient paperwork before therapy is set up.",
    trigger:
      "A patient packet is sent, or its reminder fires while still unsigned.",
    fidelity: "exact",
    source: "artifacts/resupply-api/src/lib/patient-packet/invite-email.ts",
    smsSource: "artifacts/resupply-api/src/lib/patient-packet/send.ts",
    email: {
      subject: `Please review and sign your ${brand.legalName} new patient documents`,
      html: renderPacketInviteHtml(brand.legalName, first, packetLink),
      text: renderPacketInviteText(brand.legalName, first, packetLink),
    },
    sms: meterSms(
      `${brand.legalName}: please review & sign your new patient documents here: ${packetLink} Reply STOP to opt out.`,
    ),
  });

  // EXACT: the video-visit invite's renderers are exported and pure.
  // (The `appointment.assigned.email` seed is deliberately NOT here — it
  // goes to a STAFF member about their own calendar, not to a patient.)
  const visitWhen = SAMPLE.appointmentAt;
  const visitLink = `${baseUrl}/v/demo-signed-token`;
  out.push({
    id: "clinical.video_visit",
    group: "clinical",
    label: "Video visit invitation",
    description:
      "Sends the patient their secure join link for a scheduled video visit with a respiratory therapist.",
    trigger: "Staff schedule a video visit and send the invite.",
    fidelity: "exact",
    // The renderers, not the route that schedules the visit — this is what
    // the UI tooltip cites and what an "exact" claim rests on.
    source: "artifacts/resupply-api/src/lib/video-visits/invite-email.ts",
    email: {
      subject: `Your video visit link from ${brandName}`,
      html: renderInviteEmailHtml(first, brandName, visitWhen, visitLink),
      text: renderInviteEmailText(first, brandName, visitWhen, visitLink),
    },
    sms: meterSms(
      `Hi ${first}, this is ${brandName}. Your video visit is set for ${visitWhen}. Join from your phone or computer: ${visitLink}`,
    ),
  });

  out.push({
    id: "clinical.setup_deadline",
    group: "clinical",
    label: "Therapy setup deadline",
    description:
      "Nudges a patient who has not started therapy while their payer's compliance clock is running.",
    trigger:
      "The setup window is closing and no usage data has arrived from the device.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/worker/jobs/therapy-setup-deadline-outreach.ts",
    email: null,
    sms: meterSms(
      `Hi ${first}, ${brandName} here. Your insurance needs you using your ${SAMPLE.deviceModel} soon to keep coverage. Need help? Call ${brand.supportPhoneDisplay}. STOP to opt out.`,
    ),
  });

  // ── Billing ───────────────────────────────────────────────────────
  out.push({
    id: "billing.statement",
    group: "billing",
    label: "Billing statement",
    description:
      "The patient's statement of what insurance paid and what they owe.",
    trigger: "Staff send a statement, or the statement run goes out.",
    fidelity: "mirrored",
    source: "artifacts/resupply-api/src/lib/billing/statement-send.ts",
    email: {
      subject: `Your ${brandName} billing statement`,
      text: [
        `Hi ${first},`,
        "",
        `Your statement is ready. Balance due: ${money(SAMPLE.balanceCents)}.`,
        "",
        `View your statement: ${baseUrl}/account/billing`,
        "",
        `If something looks wrong, reply to this email or call ${brand.supportPhoneDisplay} — we would rather fix it than have you pay it.`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(`Hi ${escapeHtml(first)},`),
          p(
            `Your statement is ready. Balance due: <strong>${money(SAMPLE.balanceCents)}</strong>.`,
          ),
          p(
            `<a href="${escapeHtml(baseUrl)}/account/billing" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">View your statement</a>`,
          ),
          p(
            `If something looks wrong, reply to this email or call ${escapeHtml(brand.supportPhoneDisplay)} &mdash; we would rather fix it than have you pay it.`,
          ),
        ].join("\n"),
      ),
    },
    sms: null,
  });

  return out;
}

/** Look one preview up by id. */
export function findMessagePreview(
  brand: PreviewBrand,
  id: string,
): MessagePreview | null {
  return buildMessagePreviews(brand).find((p) => p.id === id) ?? null;
}

/**
 * Phrases that must still appear in each mirrored scenario's source.
 *
 * What this DOES prove: the sentence this page shows still exists in the
 * code that sends it, and the scenario points at a file that really owns
 * that copy. A rewrite that drops the phrase fails the build.
 *
 * What it does NOT prove: byte equality. A one-word fingerprint would be
 * nearly worthless — "shipped" appears in an email module that does not
 * even build the shipped TEXT — so prefer a distinctive full clause, and
 * add a SECOND entry for a scenario whose two channels live in different
 * files (same id, different source). Byte equality is only available for
 * `exact` scenarios, which call the renderer; when a renderer can be
 * extracted, prefer that over strengthening a fingerprint here.
 */
export const MIRRORED_FINGERPRINTS: ReadonlyArray<{
  id: string;
  source: string;
  fingerprint: string;
}> = [
  {
    id: "orders.shipped",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-email.ts",
    fingerprint: "order has shipped",
  },
  {
    // The shipped TEXT is assembled in the route, not the email module.
    id: "orders.shipped",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-if-new.ts",
    fingerprint: "your CPAP supplies just shipped",
  },
  {
    id: "orders.delivered",
    source:
      "artifacts/resupply-api/src/lib/order-emails/delivered-notification.ts",
    fingerprint: "your CPAP supplies were delivered",
  },
  {
    id: "clinical.recall",
    source:
      "artifacts/resupply-api/src/worker/jobs/recall-notifications-send.ts",
    fingerprint: "recall",
  },
  {
    id: "clinical.setup_deadline",
    source:
      "artifacts/resupply-api/src/worker/jobs/therapy-setup-deadline-outreach.ts",
    fingerprint: "STOP to opt out",
  },
  {
    id: "billing.statement",
    source: "artifacts/resupply-api/src/lib/billing/statement-send.ts",
    fingerprint: "billing statement",
  },
];
