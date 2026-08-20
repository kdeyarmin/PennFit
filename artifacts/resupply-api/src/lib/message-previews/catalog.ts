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
  email: PreviewEmail | null;
  sms: PreviewSms | null;
}

/** Brand + contact values a preview renders against. */
export interface PreviewBrand {
  /** Patient-facing storefront/practice name. */
  brandName: string;
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
 * The shared shell the mirrored emails render into. It intentionally
 * matches the plain, table-based, inline-styled structure the production
 * senders use — a preview in a prettier shell than production would be
 * lying about what lands in the inbox.
 */
function shell(brand: PreviewBrand, bodyHtml: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background:#f8fafc; padding:24px; margin:0;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
${bodyHtml}
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;line-height:1.5;">
        ${escapeHtml(brand.legalName)}<br/>
        Questions? Call ${escapeHtml(brand.supportPhoneDisplay)} or reply to this email.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function p(text: string): string {
  return `      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${text}</p>`;
}

function itemsText(): string {
  return SAMPLE.items.map((i) => `  - ${i.quantity} x ${i.name}`).join("\n");
}

function itemsHtml(): string {
  return `      <ul style="margin:0 0 12px;padding-left:20px;color:#0a1f44;font-size:14px;line-height:1.55;">${SAMPLE.items
    .map((i) => `<li>${i.quantity} &times; ${escapeHtml(i.name)}</li>`)
    .join("")}</ul>`;
}

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
      practiceName: brandName,
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
      sms: meterSms(defaultReminderSmsBody(variant, first, brandName)),
    });
  }

  // ── Orders & shipping (mirrored) ──────────────────────────────────
  out.push({
    id: "orders.confirmation",
    group: "orders",
    label: "Order confirmed",
    description:
      "Receipt for a storefront order: what was bought, the total, and where it is going.",
    trigger: "Stripe reports the checkout session as paid.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-order-confirmation-email.ts",
    email: {
      subject: `Your ${brandName} order is confirmed`,
      text: [
        `Thanks for your order at ${brandName}. Your payment was received and we're getting it ready to ship.`,
        "",
        "Order summary:",
        itemsText(),
        "",
        `Total: ${money(SAMPLE.amountTotalCents)}`,
        "",
        `View your order: ${baseUrl}/shop/checkout-success?session_id=demo`,
        "",
        "We'll send another email with tracking info once your order ships. Reply to this message if you need to make a change — we read every reply.",
      ].join("\n"),
      html: shell(
        brand,
        [
          p(
            `Thanks for your order at ${escapeHtml(brandName)}. Your payment was received and we're getting it ready to ship.`,
          ),
          p("<strong>Order summary</strong>"),
          itemsHtml(),
          p(`<strong>Total: ${money(SAMPLE.amountTotalCents)}</strong>`),
          p(
            `We'll send another email with tracking info once your order ships. Reply to this message if you need to make a change &mdash; we read every reply.`,
          ),
        ].join("\n"),
      ),
    },
    sms: null,
  });

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
      subject: `Your ${brandName} order ${SAMPLE.orderNumber} shipped`,
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
    sms: meterSms(
      `Hi ${first}, ${brandName} shipped your CPAP supplies. ${SAMPLE.trackingCarrier} tracking: ${SAMPLE.trackingNumber}. Reply STOP to opt out.`,
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

  out.push({
    id: "orders.ready_for_pickup",
    group: "orders",
    label: "Ready for pickup",
    description:
      "Tells the patient their order is waiting at the branch, and where to collect it.",
    trigger: "Staff mark a pickup order ready on the fulfilment queue.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-ready-for-pickup-email.ts",
    email: {
      subject: `Your ${brandName} order is ready for pickup`,
      text: [
        `Hi ${first}, your order is packed and waiting at ${SAMPLE.pickupLocation}.`,
        "",
        "Please bring a photo ID. If someone else is collecting for you, reply to this email with their name first.",
        "",
        "What's waiting:",
        itemsText(),
      ].join("\n"),
      html: shell(
        brand,
        [
          p(
            `Hi ${escapeHtml(first)}, your order is packed and waiting at <strong>${escapeHtml(SAMPLE.pickupLocation)}</strong>.`,
          ),
          p(
            "Please bring a photo ID. If someone else is collecting for you, reply to this email with their name first.",
          ),
          itemsHtml(),
        ].join("\n"),
      ),
    },
    sms: meterSms(
      `Hi ${first}, your ${brandName} order is ready to collect at ${SAMPLE.pickupLocation}. Bring photo ID. Reply STOP to opt out.`,
    ),
  });

  out.push({
    id: "orders.refunded",
    group: "orders",
    label: "Refund issued",
    description:
      "Confirms a refund and states how long the money takes to land.",
    trigger: "Staff issue a refund from the order detail page.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-refund-notification-email.ts",
    email: {
      subject: `Your ${brandName} refund is on its way`,
      text: [
        `Hi ${first}, we've refunded ${money(SAMPLE.amountTotalCents)} for order ${SAMPLE.orderNumber}.`,
        "",
        "Refunds usually appear on your statement within 5-10 business days, depending on your bank.",
        "",
        "Reply to this email if anything looks wrong.",
      ].join("\n"),
      html: shell(
        brand,
        [
          p(
            `Hi ${escapeHtml(first)}, we've refunded <strong>${money(SAMPLE.amountTotalCents)}</strong> for order ${escapeHtml(SAMPLE.orderNumber)}.`,
          ),
          p(
            "Refunds usually appear on your statement within 5-10 business days, depending on your bank.",
          ),
        ].join("\n"),
      ),
    },
    sms: null,
  });

  // EXACT: seeded template row.
  const backInStock = fromSeed("shop.back_in_stock.email", {
    product_name: "Nasal cushion (medium)",
    product_name_html: "Nasal cushion (medium)",
    product_url: `${baseUrl}/shop`,
    product_url_html: `${baseUrl}/shop`,
    price_label: money(2400),
    price_line_text: `Price: ${money(2400)}`,
    // The two `*_block_html` variables are pre-rendered markup the sender
    // supplies; empty is a valid value (no image, no price block).
    image_block_html: "",
    price_block_html: `<div style="padding-top:10px;font-weight:700;color:#0a1f44;">${money(2400)}</div>`,
    brand_name: brandName,
    brand_name_html: brandName,
  });
  if (backInStock) {
    out.push({
      id: "orders.back_in_stock",
      group: "orders",
      label: "Back in stock",
      description:
        "Tells a patient who asked to be notified that a product they wanted is available again.",
      trigger:
        "Inventory for a product with a waiting list goes back above zero.",
      fidelity: "exact",
      source: "artifacts/resupply-api/src/lib/message-templates/seed-bodies.ts",
      email: {
        subject: backInStock.subject ?? `Back in stock at ${brandName}`,
        text: backInStock.text,
        html: backInStock.html ?? shell(brand, p(escapeHtml(backInStock.text))),
      },
      sms: null,
    });
  }

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

  out.push({
    id: "clinical.packet_esign",
    group: "clinical",
    label: "Document awaiting signature",
    description:
      "Asks the patient to e-sign a form before their order can be released.",
    trigger:
      "A patient packet is sent, or its reminder fires while still unsigned.",
    fidelity: "mirrored",
    source: "artifacts/resupply-api/src/routes/admin/provider-esign.ts",
    email: {
      subject: "Action needed: a document is awaiting your signature",
      text: [
        `Hi ${first},`,
        "",
        `${brandName} needs your signature on: ${SAMPLE.packetTitle}.`,
        "",
        `Sign it here: ${baseUrl}/p/demo-signed-token`,
        "",
        "The link is personal to you and expires for your security. Reply to this email if it has already expired and we'll send a fresh one.",
      ].join("\n"),
      html: shell(
        brand,
        [
          p(`Hi ${escapeHtml(first)},`),
          p(
            `${escapeHtml(brandName)} needs your signature on: <strong>${escapeHtml(SAMPLE.packetTitle)}</strong>.`,
          ),
          p(
            `<a href="${escapeHtml(baseUrl)}/p/demo-signed-token" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">Review and sign</a>`,
          ),
          p(
            "The link is personal to you and expires for your security. Reply to this email if it has already expired and we'll send a fresh one.",
          ),
        ].join("\n"),
      ),
    },
    sms: meterSms(
      `Hi ${first}, ${brandName} needs your signature on a form before we can ship. Sign here: ${baseUrl}/p/demo Reply STOP to opt out.`,
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
    source: "artifacts/resupply-api/src/routes/admin/video-visits.ts",
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
        `Pay online: ${baseUrl}/account/billing`,
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
            `<a href="${escapeHtml(baseUrl)}/account/billing" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">View and pay</a>`,
          ),
          p(
            `If something looks wrong, reply to this email or call ${escapeHtml(brand.supportPhoneDisplay)} &mdash; we would rather fix it than have you pay it.`,
          ),
        ].join("\n"),
      ),
    },
    sms: null,
  });

  out.push({
    id: "billing.payment_receipt",
    group: "billing",
    label: "Subscription payment receipt",
    description:
      "Receipt confirming a recurring supply-subscription charge went through.",
    trigger: "A subscription renewal payment succeeds.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-subscription-billing-email.ts",
    email: {
      subject: `Your ${brandName} subscription payment receipt`,
      text: [
        `Hi ${first},`,
        "",
        `We've charged ${money(SAMPLE.amountTotalCents)} for your ${brandName} supply subscription. Your next shipment is on its way.`,
        "",
        "Keep this email as your receipt.",
        "",
        `Manage your subscription: ${baseUrl}/account/subscriptions`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(`Hi ${escapeHtml(first)},`),
          p(
            `We've charged <strong>${money(SAMPLE.amountTotalCents)}</strong> for your ${escapeHtml(brandName)} supply subscription. Your next shipment is on its way.`,
          ),
          p("Keep this email as your receipt."),
        ].join("\n"),
      ),
    },
    sms: null,
  });

  out.push({
    id: "billing.payment_link",
    group: "billing",
    label: "Secure payment link",
    description:
      "A pay-by-link text, usually sent while the patient is on the phone with a CSR.",
    trigger: "A CSR sends a payment link from the patient's billing tab.",
    fidelity: "mirrored",
    source: "artifacts/resupply-api/src/routes/admin/patient-payment-link.ts",
    email: null,
    sms: meterSms(
      `${brandName}: your secure payment link for ${money(SAMPLE.balanceCents)} is ${baseUrl}/pay/demo Reply STOP to opt out.`,
    ),
  });

  out.push({
    id: "billing.subscription_renewal",
    group: "billing",
    label: "Subscription renews soon",
    description:
      "Gives the patient advance notice before their supply subscription charges again, so a renewal is never a surprise.",
    trigger:
      "A subscription's next billing date falls inside the advance-notice window.",
    fidelity: "mirrored",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-subscription-billing-email.ts",
    email: {
      subject: `Your ${brandName} subscription renews soon`,
      text: [
        `Hi ${first},`,
        "",
        `Your ${brandName} supply subscription renews shortly, and we'll charge the card on file ${money(SAMPLE.amountTotalCents)}.`,
        "",
        "What's coming:",
        itemsText(),
        "",
        `Need to change, pause, or cancel? ${baseUrl}/account/subscriptions`,
      ].join("\n"),
      html: shell(
        brand,
        [
          p(`Hi ${escapeHtml(first)},`),
          p(
            `Your ${escapeHtml(brandName)} supply subscription renews shortly, and we'll charge the card on file <strong>${money(SAMPLE.amountTotalCents)}</strong>.`,
          ),
          itemsHtml(),
          p(
            `<a href="${escapeHtml(baseUrl)}/account/subscriptions" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">Manage subscription</a>`,
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
 * Distinctive substrings that MUST still be present in each mirrored
 * scenario's source file. `catalog.drift.test.ts` asserts these, so
 * production copy cannot quietly diverge from what this page shows.
 * Keyed by scenario id; only mirrored entries appear.
 */
export const MIRRORED_FINGERPRINTS: ReadonlyArray<{
  id: string;
  source: string;
  fingerprint: string;
}> = [
  {
    id: "orders.confirmation",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-order-confirmation-email.ts",
    fingerprint: "order is confirmed",
  },
  {
    id: "orders.shipped",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-email.ts",
    fingerprint: "shipped",
  },
  {
    id: "orders.delivered",
    source:
      "artifacts/resupply-api/src/lib/order-emails/delivered-notification.ts",
    fingerprint: "your CPAP supplies were delivered",
  },
  {
    id: "orders.ready_for_pickup",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-ready-for-pickup-email.ts",
    fingerprint: "pickup",
  },
  {
    id: "orders.refunded",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-refund-notification-email.ts",
    fingerprint: "refund",
  },
  {
    id: "clinical.recall",
    source:
      "artifacts/resupply-api/src/worker/jobs/recall-notifications-send.ts",
    fingerprint: "recall",
  },
  {
    id: "clinical.packet_esign",
    source: "artifacts/resupply-api/src/routes/admin/provider-esign.ts",
    fingerprint: "awaiting your signature",
  },
  {
    id: "clinical.setup_deadline",
    source:
      "artifacts/resupply-api/src/worker/jobs/therapy-setup-deadline-outreach.ts",
    fingerprint: "STOP",
  },
  {
    id: "billing.statement",
    source: "artifacts/resupply-api/src/lib/billing/statement-send.ts",
    fingerprint: "billing statement",
  },
  {
    id: "billing.payment_link",
    source: "artifacts/resupply-api/src/routes/admin/patient-payment-link.ts",
    fingerprint: "payment link",
  },
  {
    id: "billing.payment_receipt",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-subscription-billing-email.ts",
    fingerprint: "subscription payment receipt",
  },
  {
    id: "billing.subscription_renewal",
    source:
      "artifacts/resupply-api/src/lib/order-emails/send-subscription-billing-email.ts",
    fingerprint: "subscription renews",
  },
];
