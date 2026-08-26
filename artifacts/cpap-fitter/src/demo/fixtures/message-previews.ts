// Demo fixtures for `/admin/message-previews` — the patient's-eye view of
// every outbound text and email.
//
// The production catalog lives server-side
// (`artifacts/resupply-api/src/lib/message-previews/catalog.ts`) and calls
// the real renderers. The SPA can't import across artifacts, so this is a
// faithful client-side stand-in: same response shape, same scenario ids,
// same fidelity labels, and copy taken from the same strings.
//
// The demo brand is the tenant's, not the platform's — a demo explorer is
// standing in a tenant's admin console, so the previews carry a tenant
// brand exactly as they would in production.
//
// Sending: the demo sandbox answers every request in-browser, so nothing
// can actually leave. `demoSendMessagePreview` therefore reports the
// not-configured branch of the REAL contract rather than claiming a
// delivery that never happened — see the note there.

const BRAND = {
  name: "Riverside CPAP",
  // getCompanyInfo().name — what the reminder worker brands with.
  companyName: "Riverside Home Medical",
  legalName: "Riverside Home Medical LLC",
  supportPhoneDisplay: "(215) 555-0100",
  baseUrl: "https://shop.riversidehomemedical.example",
};

const FIRST = "Jordan";
const ITEMS = [
  { name: "Nasal cushion (medium)", quantity: 2 },
  { name: "Headgear", quantity: 1 },
  { name: "Disposable filters (6-pack)", quantity: 1 },
];

// Mirror of the server's `meterSms`. The real one calls `gsm7Length` /
// `isGsm7` from `@workspace/resupply-messaging`, which the SPA cannot
// import at runtime: that package's index re-exports signed-link-token
// helpers built on `node:crypto`, which has no place in a browser bundle.
// So the alphabet is mirrored here — and `message-previews.gsm7.test.ts`
// imports the REAL implementation and asserts this agrees with it, so the
// copy cannot drift.
//
// "ASCII" is NOT a usable proxy for GSM-7 in either direction, which is
// what an earlier version of this got wrong:
//   * `^ { } \ [ ~ ] |` are ASCII but live in the GSM-7 EXTENSION table
//     and cost TWO septets each — counting them as one undercounts the
//     bill on the very page that exists to show segment math;
//   * a backtick is ASCII and is NOT in GSM-7 at all, so it forces the
//     whole message to UCS-2.

/** GSM 03.38 basic set — one septet each. */
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
    "¿abcdefghijklmnopqrstuvwxyzäöñüà" +
    "Δ_ΦΓΛΩΠΨΣΘΞ",
);

/** Extension table — two septets each. */
const GSM7_EXTENDED = new Set("^{}\\[~]|€");

function meter(body: string): {
  body: string;
  encoding: "GSM-7" | "UCS-2";
  characters: number;
  units: number;
  segments: number;
} {
  const chars = [...body].length;
  let septets = 0;
  let gsm7 = true;
  for (const ch of body) {
    if (GSM7_EXTENDED.has(ch)) {
      septets += 2;
      continue;
    }
    if (GSM7_BASIC.has(ch)) {
      septets += 1;
      continue;
    }
    gsm7 = false;
    break;
  }
  if (gsm7) {
    return {
      body,
      encoding: "GSM-7",
      characters: chars,
      units: septets,
      // Multi-segment GSM-7 spends 7 septets per part on the UDH header.
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  const units = body.length; // UTF-16 code units, which is what UCS-2 counts
  return {
    body,
    encoding: "UCS-2",
    characters: chars,
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

function shell(inner: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background:#f8fafc; padding:24px; margin:0;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
${inner}
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;line-height:1.5;">
        ${BRAND.legalName}<br/>
        Questions? Call ${BRAND.supportPhoneDisplay} or reply to this email.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function para(text: string): string {
  return `      <p style="margin:0 0 12px;color:#0a1f44;font-size:14px;line-height:1.55;">${text}</p>`;
}

function itemsHtml(): string {
  return `      <ul style="margin:0 0 12px;padding-left:20px;color:#0a1f44;font-size:14px;line-height:1.55;">${ITEMS.map(
    (i) => `<li>${i.quantity} &times; ${i.name}</li>`,
  ).join("")}</ul>`;
}

function itemsText(): string {
  return ITEMS.map((i) => `  - ${i.quantity} x ${i.name}`).join("\n");
}

interface DemoPreview {
  id: string;
  group: "resupply" | "orders" | "clinical" | "billing";
  label: string;
  description: string;
  trigger: string;
  fidelity: "exact" | "mirrored";
  source: string;
  /** Set when the SMS is built somewhere other than `source`. */
  smsSource?: string;
  email: { subject: string; html: string; text: string } | null;
  sms: ReturnType<typeof meter> | null;
}

/** The reminder copy, taken verbatim from `defaultReminderSmsBody`. */
function reminderSms(variant: "initial" | "followup" | "final"): string {
  switch (variant) {
    case "followup":
      return `Hi ${FIRST}, ${BRAND.name} checking back. Still use your CPAP and low on supplies? Reply YES to ship. EDIT to fix your address. STOP to opt out.`;
    case "final":
      return `Last reminder, ${FIRST}. Still use your CPAP and low on supplies? Reply YES today and ${BRAND.name} ships your order. STOP to opt out.`;
    default:
      return `Hi ${FIRST}, it's ${BRAND.name}. Time for your CPAP refill. Still use it and low on supplies? Reply YES to ship. EDIT to fix your address. STOP to opt out.`;
  }
}

const REMINDER_COPY = {
  initial: {
    subject: "Time to refill your CPAP supplies",
    intro: `You're due for a CPAP refill. ${BRAND.name} has your next order ready. Here's what's due:`,
    label: "Resupply reminder — first touch",
    description:
      "Tells the patient their supplies are due and asks them to confirm they still use the equipment and are running low.",
    trigger:
      "The resupply engine finds an eligible patient whose refill window has opened.",
  },
  followup: {
    subject: "Still time to refill your CPAP supplies",
    intro: `Just circling back from ${BRAND.name}. Your CPAP refill is ready whenever you are. Here's what's due:`,
    label: "Resupply reminder — follow-up",
    description:
      "A softer second touch when the first reminder got no reply. More outreach still to come.",
    trigger:
      "No reply to the first reminder after the configured escalation delay.",
  },
  final: {
    subject: "Last call: your CPAP refill is ready",
    intro: `This is our last reminder. We don't want you to run low, and ${BRAND.name} can ship today. Here's what's due:`,
    label: "Resupply reminder — last call",
    description:
      "The final automated touch before the queue hands the patient to a human to call.",
    trigger:
      "No reply after the follow-up, at the end of the escalation ladder.",
  },
} as const;

function buildPreviews(): DemoPreview[] {
  const out: DemoPreview[] = [];

  for (const variant of ["initial", "followup", "final"] as const) {
    const c = REMINDER_COPY[variant];
    out.push({
      id: `resupply.reminder.${variant}`,
      group: "resupply",
      label: c.label,
      description: c.description,
      trigger: c.trigger,
      fidelity: "exact",
      source: "lib/resupply-messaging/src/email-templates.ts",
      email: {
        subject: c.subject,
        text: [
          `Hi ${FIRST},`,
          "",
          c.intro,
          "",
          itemsText(),
          "",
          `Confirm and ship: ${BRAND.baseUrl}/r/c/demo-signed-token`,
          `Change your address: ${BRAND.baseUrl}/r/e/demo-signed-token`,
          `Stop these reminders: ${BRAND.baseUrl}/r/s/demo-signed-token`,
        ].join("\n"),
        html: shell(
          [
            para(`Hi ${FIRST},`),
            para(c.intro),
            itemsHtml(),
            para(
              `<a href="${BRAND.baseUrl}/r/c/demo-signed-token" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">Confirm and ship</a>`,
            ),
            para(
              `<a href="${BRAND.baseUrl}/r/e/demo-signed-token" style="color:#0a1f44;font-size:13px;">Change my address</a> &nbsp;·&nbsp; <a href="${BRAND.baseUrl}/r/s/demo-signed-token" style="color:#6b7280;font-size:13px;">Stop reminders</a>`,
            ),
          ].join("\n"),
        ),
      },
      sms: meter(reminderSms(variant)),
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
      subject: `Your ${BRAND.name} order has shipped`,
      text: [
        `Good news ${FIRST} — your ${BRAND.name} order is on its way.`,
        "",
        "Carrier: UPS",
        "Tracking: 1Z999AA10123456784",
      ].join("\n"),
      html: shell(
        [
          para(`Good news ${FIRST} — your ${BRAND.name} order is on its way.`),
          para("<strong>UPS</strong> &middot; 1Z999AA10123456784"),
          itemsHtml(),
        ].join("\n"),
      ),
    },
    smsSource:
      "artifacts/resupply-api/src/lib/order-emails/send-shipping-notification-if-new.ts",
    sms: meter(
      `Hi ${FIRST}: your CPAP supplies just shipped (UPS 1Z999AA10123456784). Reply STOP to opt out.`,
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
      subject: `Your ${BRAND.name} supplies were delivered`,
      text: `Hi ${FIRST}, the carrier says your CPAP supplies have arrived.\n\nIf you can't find the parcel, reply to this email and we'll chase it with the carrier.`,
      html: shell(
        [
          para(
            `Hi ${FIRST}, the carrier says your CPAP supplies have arrived.`,
          ),
          para(
            "If you can't find the parcel, reply to this email and we'll chase it with the carrier.",
          ),
        ].join("\n"),
      ),
    },
    sms: meter(
      `Hi ${FIRST}: your CPAP supplies were delivered. Reply STOP to opt out.`,
    ),
  });

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
      subject: "Time to renew your CPAP prescription",
      text: `Hi ${FIRST},\n\nYour prescription on file expires in 12 days.\n\nWe need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.\n\nIf you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.\n\n— ${BRAND.legalName}\n`,
      html: shell(
        [
          para(`Hi ${FIRST},`),
          para("Your prescription on file expires in 12 days."),
          para(
            "We need a fresh prescription on file before your next supply order ships. The fastest path is to ask your prescribing physician's office for a renewal — most clinics turn this around in 1-2 business days.",
          ),
          para(
            "If you'd rather have us request the renewal directly from your physician, reply to this email with your physician's name + practice and we'll handle the outreach.",
          ),
        ].join("\n"),
      ),
    },
    sms: meter(
      `Hi ${FIRST}, your CPAP prescription expires in 12 days. Ask your doctor to renew or text us their name + practice. Reply STOP to opt out. - ${BRAND.name}`,
    ),
  });

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
      subject:
        "Important safety notice about your DreamStation (first generation)",
      text: `Hi ${FIRST},\n\nThe manufacturer has issued a recall affecting the DreamStation (first generation), which our records show you use.\n\nPlease do not stop therapy before speaking to us or your physician — we will help you arrange a replacement.\n\nCall ${BRAND.supportPhoneDisplay} or reply to this email and we'll walk you through it.`,
      html: shell(
        [
          para(`Hi ${FIRST},`),
          para(
            "The manufacturer has issued a recall affecting the <strong>DreamStation (first generation)</strong>, which our records show you use.",
          ),
          para(
            "Please do not stop therapy before speaking to us or your physician &mdash; we will help you arrange a replacement.",
          ),
          para(
            `Call <strong>${BRAND.supportPhoneDisplay}</strong> or reply to this email and we'll walk you through it.`,
          ),
        ].join("\n"),
      ),
    },
    sms: meter(
      `${FIRST}, a safety recall affects your DreamStation. Do not stop therapy. Call ${BRAND.name} at ${BRAND.supportPhoneDisplay}. Reply STOP to opt out.`,
    ),
  });

  const packetLink = `${BRAND.baseUrl}/patient-packet-sign?token=demo-signed-token`;
  // Mirrors the server catalog, which renders this EXACTLY from the
  // patient-packet invite renderers. An earlier version cited
  // provider-esign.ts, whose similar notice goes to a PROVIDER and links
  // to /provider/sign-in — copy no patient ever receives.
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
    email: {
      subject: `Please review and sign your ${BRAND.legalName} new patient documents`,
      text: [
        `${BRAND.legalName}`,
        "",
        `Hello ${FIRST},`,
        "",
        "Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any device.",
        "",
        `Review & sign: ${packetLink}`,
        "",
        "This is a secure, personalized link. Please don't forward it.",
      ].join("\n"),
      html: `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${BRAND.legalName}</h1>
      <p style="font-size:15px;line-height:1.55">Hello ${FIRST},</p>
      <p style="font-size:15px;line-height:1.55">Welcome! Before we set up your therapy, please review and electronically sign your new patient documents. It only takes a few minutes on any phone, tablet, or computer.</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${packetLink}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:9999px;font-weight:bold;font-size:15px">Review &amp; sign my documents</a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#334155">${packetLink}</span></p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">This is a secure, personalized link. Please don't forward it. If you didn't expect this message, you can ignore it.</p>
    </div>
  </div></body></html>`,
    },
    sms: meter(
      `${BRAND.legalName}: please review & sign your new patient documents here: ${packetLink} Reply STOP to opt out.`,
    ),
  });

  out.push({
    id: "clinical.video_visit",
    group: "clinical",
    label: "Video visit invitation",
    description:
      "Sends the patient their secure join link for a scheduled video visit with a respiratory therapist.",
    trigger: "Staff schedule a video visit and send the invite.",
    fidelity: "exact",
    source: "artifacts/resupply-api/src/lib/video-visits/invite-email.ts",
    email: {
      subject: `Your video visit link from ${BRAND.name}`,
      text: `Hi ${FIRST},\n\nYour care team at ${BRAND.name} has set up a secure video visit to help\nyou with your equipment. You can join from your phone, tablet, or\ncomputer — no app to install, just a camera and microphone.\n\nWhen: Tuesday, March 4 at 10:15 AM\n\nJoin your video visit: ${BRAND.baseUrl}/v/demo-signed-token`,
      html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${FIRST},</p>
  <p>Your care team at <strong>${BRAND.name}</strong> has set up a
  secure video visit to help you with your equipment. You can join from your
  phone, tablet, or computer — no app to install, just a camera and microphone.</p>
  <p style="margin:0 0 12px"><strong>When:</strong> Tuesday, March 4 at 10:15 AM</p>
  <p style="margin:24px 0">
    <a href="${BRAND.baseUrl}/v/demo-signed-token" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Join your video visit</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your browser will ask permission to
  use your camera and microphone when you join. The call is encrypted
  end-to-end and is never recorded.</p>
  <p>— The ${BRAND.name} team</p>
  </body></html>`,
    },
    sms: meter(
      `Hi ${FIRST}, this is ${BRAND.name}. Your video visit is set for Tuesday, March 4 at 10:15 AM. Join from your phone or computer: ${BRAND.baseUrl}/v/demo-signed-token`,
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
    sms: meter(
      `Hi ${FIRST}, ${BRAND.name} here. Your insurance needs you using your AirSense 11 soon to keep coverage. Need help? Call ${BRAND.supportPhoneDisplay}. STOP to opt out.`,
    ),
  });

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
      subject: `Your ${BRAND.name} billing statement`,
      text: `Hi ${FIRST},\n\nYour statement is ready. Balance due: $42.15.\n\nView your statement: ${BRAND.baseUrl}/account/billing\n\nIf something looks wrong, reply to this email or call ${BRAND.supportPhoneDisplay} — we would rather fix it than have you pay it.`,
      html: shell(
        [
          para(`Hi ${FIRST},`),
          para(
            "Your statement is ready. Balance due: <strong>$42.15</strong>.",
          ),
          para(
            `<a href="${BRAND.baseUrl}/account/billing" style="display:inline-block;padding:10px 18px;background:#0a1f44;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;">View your statement</a>`,
          ),
          para(
            `If something looks wrong, reply to this email or call ${BRAND.supportPhoneDisplay} &mdash; we would rather fix it than have you pay it.`,
          ),
        ].join("\n"),
      ),
    },
    sms: null,
  });

  return out;
}

/** GET /admin/message-previews */
export function demoMessagePreviews() {
  return {
    // Demo mode has no vendor credentials and no network, so both channels
    // report unconfigured. That is the honest state AND it makes the page
    // explain what to do instead of offering a Send button that can't work.
    sending: {
      email: { configured: false, from: null },
      sms: { configured: false, from: null },
    },
    brand: BRAND,
    previews: buildPreviews(),
  };
}

/**
 * POST /admin/message-previews/:id/send
 *
 * The demo sandbox answers every request in-browser — no request ever
 * reaches a network, so no message can actually be delivered. Rather than
 * report a success that did not happen, this returns the REAL contract's
 * `not_configured` branch (a 200 with `ok: false`), which is also exactly
 * what a live deployment returns when its SendGrid/Twilio credentials are
 * unset. The page renders the same message either way.
 */
export function demoSendMessagePreview(
  id: string,
  channel: "email" | "sms",
): {
  ok: false;
  channel: "email" | "sms";
  code: "not_configured";
  message: string;
} {
  const known = buildPreviews().some((p) => p.id === id);
  return {
    ok: false,
    channel,
    code: "not_configured",
    message: known
      ? `Demo mode can't send a real ${channel === "email" ? "email" : "text"} — nothing leaves your browser here. Exit the demo and add your ${channel === "email" ? "SendGrid" : "Twilio"} credentials to send this to yourself for real.`
      : "Unknown message scenario.",
  };
}
