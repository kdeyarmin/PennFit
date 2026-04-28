import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getListConversationsQueryKey,
  ListConversationsChannel,
  ListConversationsStatus,
  useListConversations,
} from "@workspace/resupply-api-client";
import type { ListConversationsParams } from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  humanizeStatus,
} from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Pagination } from "../components/Pagination";
import { Label, Select } from "../components/Input";
import { Button } from "../components/Button";
import { fullName, formatDateTime } from "../lib/format";

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
};

export function ConversationsPage() {
  const [location, setLocation] = useLocation();

  // Read initial filter from URL on first mount so deep links from
  // the dashboard ("Awaiting admin queue") land prefiltered.
  const initialStatus = useMemo(() => readQueryParam(location, "status"), []);
  const initialChannel = useMemo(() => readQueryParam(location, "channel"), []);

  const [statusFilter, setStatusFilter] = useState<string>(initialStatus ?? "");
  const [channelFilter, setChannelFilter] = useState<string>(
    initialChannel ?? "",
  );
  const [offset, setOffset] = useState<number>(0);

  // Reset to first page on any filter change.
  useEffect(() => {
    setOffset(0);
  }, [statusFilter, channelFilter]);

  const params: ListConversationsParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListConversationsStatus }
        : {}),
      ...(channelFilter
        ? { channel: channelFilter as keyof typeof ListConversationsChannel }
        : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, channelFilter, offset],
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
        <div className="font-semibold" style={{ color: "#0a1f44" }}>
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
      key: "last",
      header: "Last message",
      render: (r) => (
        <span className="text-xs" style={{ color: "#374151" }}>
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
          style={{ color: "#0a1f44" }}
        >
          Conversations
        </h1>
        <p className="text-sm" style={{ color: "#374151" }}>
          Cross-channel inbox. Body content is decrypted only when an admin
          opens a single thread.
        </p>
      </header>

      <Card>
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
              }}
            >
              Clear filters
            </Button>
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
