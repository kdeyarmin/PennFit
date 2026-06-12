// Patient-detail "Episodes" tab — extracted from patient-detail.tsx.
//
// Read-only table of the patient's resupply episodes (item, status,
// due / expiry dates). Rows come pre-loaded on the patient record.

import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  episodeStatusVariant,
  humanizeStatus,
} from "@/components/admin/Badge";
import { EmptyState } from "@/components/admin/EmptyState";
import { formatDate } from "@/lib/admin/format";

type Episode = {
  id: string;
  prescriptionId: string;
  itemSku: string;
  status: string;
  dueAt: string;
  expiresAt?: string | null;
  createdAt: string;
};

export function EpisodesTab({ episodes }: { episodes: Episode[] }) {
  const cols: Column<Episode>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={episodeStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    { key: "due", header: "Due", render: (r) => formatDate(r.dueAt) },
    { key: "exp", header: "Expires", render: (r) => formatDate(r.expiresAt) },
  ];
  return (
    <Table
      columns={cols}
      rows={episodes}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No episodes for this patient yet." />}
    />
  );
}
