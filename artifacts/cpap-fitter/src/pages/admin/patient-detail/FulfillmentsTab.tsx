// Patient-detail "Fulfillments" tab — extracted from patient-detail.tsx.
//
// Read-only table of fulfillment activity (item, qty, status, PACware
// ref, shipped / delivered dates). Rows come pre-loaded on the patient
// record.

import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  fulfillmentStatusVariant,
  humanizeStatus,
} from "@/components/admin/Badge";
import { EmptyState } from "@/components/admin/EmptyState";
import { formatDate } from "@/lib/admin/format";

type Fulfillment = {
  id: string;
  episodeId: string;
  itemSku: string;
  quantity: number;
  status: string;
  pacwareOrderRef?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
};

export function FulfillmentsTab({
  fulfillments,
}: {
  fulfillments: Fulfillment[];
}) {
  const cols: Column<Fulfillment>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    { key: "qty", header: "Qty", render: (r) => r.quantity },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={fulfillmentStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "ref",
      header: "PACware ref",
      render: (r) => r.pacwareOrderRef ?? "—",
    },
    {
      key: "ship",
      header: "Shipped",
      render: (r) => formatDate(r.shippedAt),
    },
    {
      key: "deliv",
      header: "Delivered",
      render: (r) => formatDate(r.deliveredAt),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={fulfillments}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No fulfillment activity yet." />}
    />
  );
}
