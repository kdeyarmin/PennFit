// Status badge with brand-tinted variants. Variant choice is by status
// SEMANTIC tier rather than per-enum, so a new status that means
// "needs human attention" can use the same `warning` color without
// adding a new branch. The status-to-tier mapping lives next to each
// page so renderers stay declarative.

type Variant = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

// Status badges. neutral / info pull from the brand tokens so a
// "navy" badge always matches the rest of the chrome; success /
// warning / danger keep their semantic palettes (green / amber /
// rose) so a "Failed" badge reads as alarm regardless of theme tweaks.
const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
  neutral: {
    bg: "hsl(var(--penn-navy) / 0.06)",
    fg: "hsl(var(--penn-navy-deep))",
    border: "hsl(var(--penn-navy) / 0.18)",
  },
  info: {
    bg: "hsl(213 80% 50% / 0.10)",
    fg: "hsl(213 80% 32%)",
    border: "hsl(213 80% 50% / 0.30)",
  },
  success: {
    bg: "hsl(152 60% 38% / 0.12)",
    fg: "hsl(152 70% 24%)",
    border: "hsl(152 60% 38% / 0.30)",
  },
  warning: {
    bg: "hsl(38 95% 48% / 0.14)",
    fg: "hsl(38 80% 28%)",
    border: "hsl(38 95% 48% / 0.40)",
  },
  danger: {
    bg: "hsl(354 75% 50% / 0.10)",
    fg: "hsl(354 75% 38%)",
    border: "hsl(354 75% 50% / 0.30)",
  },
  muted: {
    bg: "hsl(var(--surface-3))",
    fg: "hsl(var(--ink-3))",
    border: "hsl(var(--line-1))",
  },
};

export function Badge({
  variant = "neutral",
  children,
}: {
  variant?: Variant;
  children: React.ReactNode;
}) {
  const v = VARIANTS[variant];
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap"
      style={{ backgroundColor: v.bg, color: v.fg, borderColor: v.border }}
    >
      {children}
    </span>
  );
}

// Centralised status → variant + label mappings used by every list
// page. Co-locating prevents the same enum from being styled three
// different ways across pages.

export function patientStatusVariant(status: string): Variant {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "closed":
      return "muted";
    default:
      return "neutral";
  }
}

export function conversationStatusVariant(status: string): Variant {
  switch (status) {
    case "open":
      return "info";
    case "awaiting_patient":
      return "neutral";
    case "awaiting_admin":
      return "warning";
    case "closed":
      return "muted";
    default:
      return "neutral";
  }
}

export function episodeStatusVariant(status: string): Variant {
  switch (status) {
    case "outreach_pending":
    case "awaiting_response":
      return "warning";
    case "confirmed":
      return "info";
    case "fulfilled":
      return "success";
    case "declined":
    case "expired":
    case "canceled":
      return "muted";
    default:
      return "neutral";
  }
}

export function fulfillmentStatusVariant(status: string): Variant {
  switch (status) {
    case "queued":
    case "submitted_to_pacware":
    case "in_fulfillment":
      return "info";
    case "shipped":
    case "delivered":
      return "success";
    case "canceled":
      return "muted";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function channelVariant(channel: string): Variant {
  switch (channel) {
    case "sms":
      return "info";
    case "email":
      return "neutral";
    case "voice":
      return "success";
    // In-app threads (PR #53) — distinctive variant so the inbox
    // can tell at a glance whether a row is a phone-channel
    // conversation or a customer-account chat.
    case "in_app":
      return "warning";
    default:
      return "muted";
  }
}

// Human-readable label for every enum used in the UI. Keep in sync
// with the openapi enums.
export function humanizeStatus(s: string | null | undefined): string {
  if (!s) return "—";
  return s
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Acronyms we keep in their canonical uppercase form when humanising
// action / metadata strings. "Sid" is the Twilio resource-identifier
// suffix (callSid, messageSid). "Id" is the generic database
// identifier suffix (patientId, episodeId). The rest are common
// industry acronyms that show up in audit metadata.
const HUMANIZE_ACRONYMS = new Set([
  "ID",
  "SID",
  "CSV",
  "SMS",
  "MMS",
  "URL",
  "API",
  "HTTP",
  "JSON",
  "PHI",
  "IVR",
  "DTMF",
  "CRM",
  "EHR",
]);

function titleCaseWord(word: string): string {
  if (word.length === 0) return word;
  const upper = word.toUpperCase();
  if (HUMANIZE_ACRONYMS.has(upper)) return upper;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// Humanise an audit-log action code, target table name, or metadata
// key into a readable label the operator can scan. Examples:
//   "patient.prescription.status_changed" → "Patient Prescription Status Changed"
//   "voice.call.placed"                   → "Voice Call Placed"
//   "messaging.handoff.escalated"         → "Messaging Handoff Escalated"
//   "messageSid"                          → "Message SID"
//   "patientId"                           → "Patient ID"
//   "audit.export.csv"                    → "Audit Export CSV"
//
// Splits on three boundaries: "." (namespace separator), "_" (snake_
// case word break), and camelCase transitions (e.g. messageCount →
// "Message Count"). Strips any trailing key=value args because those
// belong in a metadata chip, not in the headline. Preserves a small
// set of well-known acronyms (see HUMANIZE_ACRONYMS). The raw
// machine code should still be surfaced via a `title` tooltip on the
// rendered element so engineers and auditors can grep / cross-
// reference the original key.
export function humanizeAction(action: string | null | undefined): string {
  if (!action) return "—";
  const trimmed = action.trim();
  if (trimmed.length === 0) return "—";
  // Strip trailing key=value args (used by cpap-fitter admin_audit_log
  // entries for context).
  const head = trimmed.split(/\s+/)[0] ?? trimmed;
  return head
    .split(/[._]/)
    .filter(Boolean)
    .flatMap((segment) =>
      // Split camelCase: insert spaces at lower→upper and ACR→Word
      // boundaries so "messageSid" → ["message", "Sid"] and
      // "HTTPRequest" → ["HTTP", "Request"].
      segment
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/\s+/)
        .filter(Boolean),
    )
    .map(titleCaseWord)
    .join(" ");
}
