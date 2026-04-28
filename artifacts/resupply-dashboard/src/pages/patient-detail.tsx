import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetPatient } from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  episodeStatusVariant,
  fulfillmentStatusVariant,
  humanizeStatus,
  patientStatusVariant,
} from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { fullName, formatDate, formatDateTime } from "../lib/format";

type Tab = "episodes" | "conversations" | "fulfillments" | "prescriptions";

export function PatientDetailPage({ id }: { id: string }) {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("episodes");
  const { data, isPending, isError, error, refetch } = useGetPatient(id);

  if (isError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load patient"
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <Card>
          <Spinner label="Loading patient…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <BackLink />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-semibold mb-1"
              style={{ color: "#0a1f44" }}
            >
              {fullName(data.firstName, data.lastName)}
            </h1>
            <p className="text-xs" style={{ color: "#6b7280" }}>
              PACware ID #{data.pacwareId} · Patient created {formatDate(data.createdAt)}
            </p>
          </div>
          <Badge variant={patientStatusVariant(data.status)}>
            {humanizeStatus(data.status)}
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "#c9a24a" }}
            >
              Channels on file
            </p>
            <div className="flex gap-2">
              {data.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
              {data.hasEmail && <Badge variant="neutral">Email</Badge>}
              {!data.hasPhone && !data.hasEmail && (
                <Badge variant="muted">No contact methods on file</Badge>
              )}
            </div>
          </div>
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "#c9a24a" }}
            >
              Last updated
            </p>
            <p style={{ color: "#0a1f44" }}>{formatDateTime(data.updatedAt)}</p>
          </div>
        </div>
      </Card>

      <div
        className="flex gap-1 border-b"
        style={{ borderColor: "#e5e7eb" }}
        role="tablist"
      >
        <TabButton active={tab === "episodes"} onClick={() => setTab("episodes")}>
          Episodes ({data.episodes.length})
        </TabButton>
        <TabButton
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
        >
          Conversations ({data.conversations.length})
        </TabButton>
        <TabButton
          active={tab === "fulfillments"}
          onClick={() => setTab("fulfillments")}
        >
          Fulfillments ({data.fulfillments.length})
        </TabButton>
        <TabButton
          active={tab === "prescriptions"}
          onClick={() => setTab("prescriptions")}
        >
          Prescriptions ({data.prescriptions.length})
        </TabButton>
      </div>

      <Card>
        {tab === "episodes" && <EpisodesTab episodes={data.episodes} />}
        {tab === "conversations" && (
          <ConversationsTab
            conversations={data.conversations}
            onRowClick={(cid) => setLocation(`/conversations/${cid}`)}
          />
        )}
        {tab === "fulfillments" && (
          <FulfillmentsTab fulfillments={data.fulfillments} />
        )}
        {tab === "prescriptions" && (
          <PrescriptionsTab prescriptions={data.prescriptions} />
        )}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/patients"
      className="text-sm underline"
      style={{ color: "#0a1f44" }}
    >
      ← Back to patients
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
      style={{
        color: active ? "#0a1f44" : "#6b7280",
        borderColor: active ? "#c9a24a" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

type Episode = {
  id: string;
  prescriptionId: string;
  itemSku: string;
  status: string;
  dueAt: string;
  expiresAt?: string | null;
  createdAt: string;
};

function EpisodesTab({ episodes }: { episodes: Episode[] }) {
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

type Conversation = {
  id: string;
  episodeId: string;
  channel: string;
  status: string;
  lastMessageAt?: string | null;
  createdAt: string;
};

function ConversationsTab({
  conversations,
  onRowClick,
}: {
  conversations: Conversation[];
  onRowClick: (id: string) => void;
}) {
  const cols: Column<Conversation>[] = [
    {
      key: "channel",
      header: "Channel",
      render: (r) => (
        <Badge variant={channelVariant(r.channel)}>
          {humanizeStatus(r.channel)}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={conversationStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "last",
      header: "Last message",
      render: (r) => formatDateTime(r.lastMessageAt),
    },
    {
      key: "open",
      header: "",
      render: () => (
        <span className="text-xs underline" style={{ color: "#0a1f44" }}>
          Open →
        </span>
      ),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={conversations}
      rowKey={(r) => r.id}
      onRowClick={(r) => onRowClick(r.id)}
      emptyState={
        <EmptyState
          title="No recent conversations."
          hint="Up to 10 most recent are shown here."
        />
      }
    />
  );
}

type Fulfillment = {
  id: string;
  episodeId: string;
  itemSku: string;
  quantity: string;
  status: string;
  pacwareOrderRef?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
};

function FulfillmentsTab({ fulfillments }: { fulfillments: Fulfillment[] }) {
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

type Prescription = {
  id: string;
  itemSku: string;
  cadenceDays: number;
  validFrom: string;
  validUntil?: string | null;
  status: string;
  createdAt: string;
};

function PrescriptionsTab({ prescriptions }: { prescriptions: Prescription[] }) {
  const cols: Column<Prescription>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => `${r.cadenceDays} days`,
    },
    { key: "from", header: "Valid from", render: (r) => formatDate(r.validFrom) },
    {
      key: "until",
      header: "Valid until",
      render: (r) => formatDate(r.validUntil),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={r.status === "active" ? "success" : "muted"}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={prescriptions}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No prescriptions on file." />}
    />
  );
}

