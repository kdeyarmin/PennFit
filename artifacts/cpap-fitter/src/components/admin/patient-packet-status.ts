import type { PatientPacketStatus } from "@workspace/api-client-react/admin";

export type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

export const STATUS_VARIANT: Record<PatientPacketStatus, BadgeVariant> = {
  draft: "muted",
  sent: "info",
  viewed: "info",
  completed: "success",
  voided: "danger",
  expired: "warning",
};

export const STATUS_LABEL: Record<PatientPacketStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Opened",
  completed: "Signed",
  voided: "Voided",
  expired: "Expired",
};

export function fmtPatientPacketDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function patientPacketReceiptLabel(packet: {
  status: PatientPacketStatus;
  chart_document_id?: string | null;
}): string {
  switch (packet.status) {
    case "completed":
      return packet.chart_document_id
        ? "Signature received and filed"
        : "Signature received";
    case "viewed":
      return "Opened, awaiting signature";
    case "sent":
      return "Awaiting signature";
    case "expired":
      return "Expired, no signature";
    case "voided":
      return "Voided";
    case "draft":
      return "Draft";
  }
}

export function patientPacketReceiptVariant(packet: {
  status: PatientPacketStatus;
}): BadgeVariant {
  switch (packet.status) {
    case "completed":
      return "success";
    case "viewed":
    case "sent":
      return "info";
    case "expired":
      return "warning";
    case "voided":
      return "danger";
    case "draft":
      return "muted";
  }
}

export function patientPacketReceiptDescription(packet: {
  status: PatientPacketStatus;
  patient_id?: string | null;
  chart_document_id?: string | null;
  chart_filed_at?: string | null;
  first_viewed_at?: string | null;
  completed_at?: string | null;
}): string {
  if (packet.status === "completed") {
    if (packet.chart_document_id) {
      return `Signature received${
        packet.completed_at
          ? ` on ${fmtPatientPacketDate(packet.completed_at)}`
          : ""
      }; the signed PDF is filed to the patient chart${
        packet.chart_filed_at
          ? ` as of ${fmtPatientPacketDate(packet.chart_filed_at)}`
          : ""
      }.`;
    }
    return packet.patient_id
      ? "Signature received. Download the signed PDF below if it still needs manual chart filing."
      : "Signature received. This packet is not linked to a patient chart.";
  }
  if (packet.status === "viewed") {
    return `The signer opened the link${
      packet.first_viewed_at
        ? ` on ${fmtPatientPacketDate(packet.first_viewed_at)}`
        : ""
    }, but the signature has not been received yet.`;
  }
  if (packet.status === "sent") {
    return "The signing link has been sent. Receipt is verified here once the patient completes the packet.";
  }
  if (packet.status === "expired") {
    return "The signing link expired before a signature was received. Resend or create a new packet if it is still needed.";
  }
  if (packet.status === "voided") {
    return "This packet was voided and will not accept a signature.";
  }
  return "This packet is still a draft and has not been sent for signature.";
}
