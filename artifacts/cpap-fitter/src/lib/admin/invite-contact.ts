// One-field contact parsing for the dashboard's quick fitter-invite
// sender.
//
// The staff-facing flow used to be: pick a channel, then fill the
// matching field. That's one decision too many for something a CSR does
// dozens of times a day — the contact detail already says which channel
// it is. So the Home card takes a single "mobile number or email" box
// and infers the channel from what was typed; the caller only shows the
// channel back for confirmation.
//
// Pure + DOM-free so it unit-tests in the default node environment.

export type InviteContactChannel = "email" | "sms";

export type InviteContact =
  /** Nothing typed yet. */
  | { kind: "empty" }
  /** A deliverable email address. */
  | { kind: "email"; channel: "email"; email: string; display: string }
  /** A deliverable phone number, normalized to E.164 for the API. */
  | { kind: "phone"; channel: "sms"; phoneE164: string; display: string }
  /** Typed something, but it isn't a usable address/number yet. */
  | { kind: "invalid"; reason: string };

/** Same shape the invite modal validates against, and about as strict as
 *  a client-side email check should be — SendGrid is the real judge. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The API caps `email` at 200 chars (Zod `.max(200)`); reject longer
 *  input here so the operator gets a readable message instead of a 400. */
const EMAIL_MAX = 200;

/** Mirrors the server's E.164 check in routes/admin/fitter-invites.ts. */
const E164_RE = /^\+\d{10,15}$/;

const INVALID_CONTACT = "Enter a 10-digit mobile number or an email address.";

/**
 * Decide what the operator typed and, when it's usable, normalize it into
 * exactly what `POST /admin/fitter-invites` wants.
 *
 * An "@" anywhere means they're going for email — that branch never falls
 * through to phone parsing, so a typo'd address reports an email problem
 * rather than the confusing "not a valid phone number".
 */
export function parseInviteContact(raw: string): InviteContact {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };

  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase();
    if (email.length > EMAIL_MAX) {
      return { kind: "invalid", reason: "That email address is too long." };
    }
    if (!EMAIL_RE.test(email)) {
      return { kind: "invalid", reason: "Enter a valid email address." };
    }
    return { kind: "email", channel: "email", email, display: email };
  }

  const phoneE164 = normalizePhoneE164(trimmed);
  if (!phoneE164) return { kind: "invalid", reason: INVALID_CONTACT };
  return {
    kind: "phone",
    channel: "sms",
    phoneE164,
    display: formatPhoneDisplay(phoneE164),
  };
}

/**
 * Normalize a typed phone number to E.164, or null when it can't be.
 *
 * Accepts the three shapes staff actually type: a bare 10-digit US
 * number, the same with a leading 1, and an already-international
 * "+…" number (so a tenant with non-US patients isn't blocked by a
 * US-only assumption the server doesn't make either).
 */
export function normalizePhoneE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const candidate = `+${trimmed.slice(1).replace(/[^\d]/g, "")}`;
    return E164_RE.test(candidate) ? candidate : null;
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Render an E.164 number the way staff read it back over the phone.
 * US/NANP numbers get (215) 555-1234; anything else is left as typed —
 * guessing at another country's grouping would be worse than not.
 */
export function formatPhoneDisplay(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `(${us[1]}) ${us[2]}-${us[3]}` : e164;
}
