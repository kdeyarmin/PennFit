// Status badge with brand-tinted variants. Variant choice is by status
// SEMANTIC tier rather than per-enum, so a new status that means
// "needs human attention" can use the same `warning` color without
// adding a new branch. The status-to-tier mapping lives next to each
// page so renderers stay declarative.

type Variant = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
  neutral: { bg: "#f1f5f9", fg: "#0a1f44", border: "#e5e7eb" },
  info: { bg: "#e0eaff", fg: "#1e3a8a", border: "#bfd1ff" },
  success: { bg: "#dcfce7", fg: "#166534", border: "#bbf7d0" },
  warning: { bg: "#fef3c7", fg: "#854d0e", border: "#fde68a" },
  danger: { bg: "#fee2e2", fg: "#991b1b", border: "#fecaca" },
  muted: { bg: "#f3f4f6", fg: "#6b7280", border: "#e5e7eb" },
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
