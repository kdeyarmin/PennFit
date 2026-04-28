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
