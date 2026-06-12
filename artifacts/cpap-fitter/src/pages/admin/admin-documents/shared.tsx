// /admin/documents — shared status maps, formatting helpers, and the
// plain Textarea used by the document/packet editors.

import type {
  ManualDocumentPacketStatus,
  ManualDocumentStatus,
} from "@/lib/admin/manual-documents-api";

export type BadgeVariant =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "muted";

export const STATUS_VARIANT: Record<ManualDocumentStatus, BadgeVariant> = {
  draft: "muted",
  sent: "info",
  attached: "success",
};

export const STATUS_LABEL: Record<ManualDocumentStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  attached: "Filed to chart",
};

export const PACKET_STATUS_VARIANT: Record<
  ManualDocumentPacketStatus,
  BadgeVariant
> = {
  draft: "muted",
  sent: "info",
};

export const PACKET_STATUS_LABEL: Record<ManualDocumentPacketStatus, string> = {
  draft: "Draft",
  sent: "Sent",
};

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function Textarea({
  id,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="block w-full rounded-md border px-3 py-1.5 text-sm bg-white"
      style={{ borderColor: "hsl(var(--line-2))", color: "hsl(var(--ink-1))" }}
    />
  );
}
