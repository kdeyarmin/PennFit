// Reply-templates library for the in-thread reply composer.
//
// Six common operator responses, channel-aware (SMS templates stay
// short to avoid multi-part split costs; email templates can run
// longer). Each template body may contain `{firstName}` which the
// composer substitutes with the patient's decrypted first name at
// insert time.
//
// We deliberately keep this hardcoded for v1. A DB-backed template
// store with admin CRUD would be Tier 2 work — useful, but the
// pain point ("I keep typing the same response") is solved by a
// short curated list. Adding/editing templates here is a code
// change but the universe of templates is small enough that
// shipping a CMS for them isn't justified yet.
//
// PHI safety: templates themselves contain no PHI; the
// `{firstName}` substitution happens in the browser using data
// already on screen, so the template store on the server side
// stays patient-agnostic.

export interface ReplyTemplate {
  id: string;
  label: string;
  channels: ReadonlyArray<"sms" | "email">;
  body: string;
}

export const REPLY_TEMPLATES: ReadonlyArray<ReplyTemplate> = [
  {
    id: "confirm",
    label: "Confirm — order placed",
    channels: ["sms", "email"],
    body: "Hi {firstName}, thanks for confirming! We'll get your resupply order out the door this week. Reply STOP to opt out.",
  },
  {
    id: "decline",
    label: "Acknowledge decline",
    channels: ["sms", "email"],
    body: "Got it, {firstName} — we'll skip this cycle and reach out at your next refill window. Let us know if anything changes.",
  },
  {
    id: "need-rx",
    label: "Need updated prescription",
    channels: ["sms", "email"],
    body: "Hi {firstName}, before we can ship your resupply we need an updated prescription on file. Could you ask your provider to fax or email it to us? Thanks!",
  },
  {
    id: "shipping-eta",
    label: "Shipping ETA — 3-5 days",
    channels: ["sms", "email"],
    body: "Hi {firstName}, your order is in the queue. Standard shipping takes 3-5 business days. We'll send a tracking link once it's out.",
  },
  {
    id: "address-check",
    label: "Confirm shipping address",
    channels: ["sms", "email"],
    body: "Hi {firstName}, can you confirm we should ship to the address we have on file? If anything's changed, just reply with the new one.",
  },
  {
    id: "callback",
    label: "Offer phone callback",
    channels: ["sms", "email"],
    body: "Hi {firstName}, easier to talk through it? Reply with a good time and we'll give you a quick call.",
  },
];

/**
 * Substitute `{firstName}` with the patient's first name. If
 * firstName is empty/whitespace, falls back to "there" so the
 * sentence still scans.
 */
export function applyTemplate(body: string, firstName: string): string {
  const safe = firstName.trim() || "there";
  return body.replaceAll("{firstName}", safe);
}

/**
 * Filter templates to those that make sense on the given channel.
 * Voice channel has no templates — it's not text-based.
 */
export function templatesForChannel(
  channel: string,
): ReadonlyArray<ReplyTemplate> {
  if (channel !== "sms" && channel !== "email") return [];
  return REPLY_TEMPLATES.filter((t) =>
    t.channels.includes(channel as "sms" | "email"),
  );
}
