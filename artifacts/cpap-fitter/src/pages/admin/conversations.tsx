import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getListConversationsQueryKey,
  ListConversationsChannel,
  ListConversationsStatus,
  useListConversations,
} from "@workspace/api-client-react/admin";
import type { ListConversationsParams } from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  humanizeStatus,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Pagination } from "@/components/admin/Pagination";
import { Label, Select } from "@/components/admin/Input";
import { Button } from "@/components/admin/Button";
import { fullName, formatDateTime } from "@/lib/admin/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListConversationsStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));
const CHANNEL_OPTIONS = Object.values(ListConversationsChannel).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

type Row = {
  id: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  channel: string;
  status: string;
  lastMessageAt?: string | null;
  createdAt: string;
  // Assignment / SLA fields surfaced from the backend (additive — older
  // generated client doesn't know about them yet).
  assignedAdminUserId?: string | null;
  assignedAt?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  slaDueAt?: string | null;
  escalatedAt?: string | null;
  escalationReason?: string | null;
};

type InboxView = "" | "mine" | "unassigned" | "escalated" | "breaching";

const VIEW_LABELS: Record<InboxView, string> = {
  "": "All",
  mine: "My queue",
  unassigned: "Unassigned",
  escalated: "Escalated",
  breaching: "Breaching SLA",
};

export function ConversationsPage() {
  const [location, setLocation] = useLocation();

  // Read initial filter from URL on first mount so deep links from
  // the dashboard ("Awaiting admin queue") land prefiltered.
  const initialStatus = useMemo(() => readQueryParam(location, "status"), []);
  const initialChannel = useMemo(() => readQueryParam(location, "channel"), []);
  const initialView = useMemo(
    () => (readQueryParam(location, "view") as InboxView | null) ?? "",
    [],
  );

  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? "");
  const [channelFilter, setChannelFilter] = useState<string>(
    initialChannel ?? "",
  );
  const [view, setView] = useState<InboxView>(initialView);
  const [offset, setOffset] = useState<number>(0);

  // Reset to first page on any filter change.
  useEffect(() => {
    setOffset(0);
  }, [statusFilter, channelFilter, view]);

  const params: ListConversationsParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListConversationsStatus }
        : {}),
      ...(channelFilter
        ? { channel: channelFilter as keyof typeof ListConversationsChannel }
        : {}),
      // The new `view` parameter isn't in the generated zod schema yet;
      // it's a server-side-only filter we pass through. Cast through
      // unknown to satisfy the strict generated type.
      ...(view ? ({ view } as unknown as Partial<ListConversationsParams>) : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, channelFilter, view, offset],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListConversations(params, {
      query: {
        queryKey: getListConversationsQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  const cols: Column<Row>[] = [
    {
      key: "patient",
      header: "Patient",
      render: (r) => (
        <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
          {fullName(r.patientFirstName, r.patientLastName)}
        </div>
      ),
    },
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
      key: "priority",
      header: "Priority",
      render: (r) => <PriorityPill priority={r.priority ?? "normal"} />,
    },
    {
      key: "sla",
      header: "SLA",
      render: (r) => <SlaCell slaDueAt={r.slaDueAt ?? null} status={r.status} />,
    },
    {
      key: "assignee",
      header: "Assignee",
      render: (r) =>
        r.assignedAdminUserId ? (
          <span
            className="text-[11px] font-mono"
            style={{ color: "hsl(var(--ink-2))" }}
            title={r.assignedAdminUserId}
          >
            {r.assignedAdminUserId.slice(-8)}
          </span>
        ) : (
          <span className="text-[11px] italic" style={{ color: "#9ca3af" }}>
            Unassigned
          </span>
        ),
    },
    {
      key: "last",
      header: "Last message",
      render: (r) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
          {formatDateTime(r.lastMessageAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Conversations
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Cross-channel inbox. Body content is decrypted only when an admin
          opens a single thread.
        </p>
      </header>

      <Card>
        <div className="space-y-4">
          <div role="tablist" className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-slate-100">
            {(Object.keys(VIEW_LABELS) as InboxView[]).map((v) => {
              const active = v === view;
              return (
                <button
                  key={v || "all"}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                    active
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                  data-testid={`conv-view-${v || "all"}`}
                >
                  {VIEW_LABELS[v]}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="conv-status">Status</Label>
              <Select
                id="conv-status"
                value={statusFilter}
                emptyOptionLabel="All statuses"
                options={STATUS_OPTIONS}
                onChange={(e) => setStatusFilter(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="conv-channel">Channel</Label>
              <Select
                id="conv-channel"
                value={channelFilter}
                emptyOptionLabel="All channels"
                options={CHANNEL_OPTIONS}
                onChange={(e) => setChannelFilter(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                intent="ghost"
                size="sm"
                onClick={() => {
                  setStatusFilter("");
                  setChannelFilter("");
                  setView("");
                }}
              >
                Clear filters
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading conversations…" />
          ) : (
            <>
              <Table
                columns={cols}
                rows={data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setLocation(`/conversations/${r.id}`)}
                emptyState={
                  <EmptyState
                    title="No conversations match this view."
                    hint="Adjust filters or clear them to see the full inbox."
                  />
                }
              />
              <Pagination
                total={data.total}
                limit={data.limit}
                offset={data.offset}
                onChange={setOffset}
                isLoading={isFetching}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function readQueryParam(location: string, key: string): string | null {
  const qIndex = location.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(location.slice(qIndex + 1)).get(key);
}

const PRIORITY_TONE: Record<NonNullable<Row["priority"]>, string> = {
  urgent: "bg-rose-100 text-rose-900 border-rose-300",
  high: "bg-amber-100 text-amber-900 border-amber-300",
  normal: "bg-slate-100 text-slate-700 border-slate-200",
  low: "bg-slate-50 text-slate-500 border-slate-200",
};

function PriorityPill({ priority }: { priority: NonNullable<Row["priority"]> }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${PRIORITY_TONE[priority]}`}
    >
      {priority}
    </span>
  );
}

function SlaCell({
  slaDueAt,
  status,
}: {
  slaDueAt: string | null;
  status: string;
}) {
  if (!slaDueAt || (status !== "open" && status !== "awaiting_admin")) {
    return <span className="text-[11px]" style={{ color: "#9ca3af" }}>—</span>;
  }
  const due = new Date(slaDueAt);
  const minsLeft = Math.round((due.getTime() - Date.now()) / 60000);
  const breached = minsLeft <= 0;
  const soon = !breached && minsLeft <= 30;
  const label = breached
    ? `${Math.abs(minsLeft)}m overdue`
    : minsLeft < 60
      ? `${minsLeft}m left`
      : `${Math.round(minsLeft / 60)}h left`;
  return (
    <span
      className={`text-[11px] font-semibold tabular-nums ${
        breached
          ? "text-rose-700"
          : soon
            ? "text-amber-700"
            : "text-slate-600"
      }`}
      title={due.toLocaleString()}
    >
      {label}
    </span>
  );
}
