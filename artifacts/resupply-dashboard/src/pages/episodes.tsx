import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  getListEpisodesQueryKey,
  ListEpisodesStatus,
  useListEpisodes,
  useSendSmsReminder,
  useSendEmailReminder,
  usePlaceVoiceCall,
} from "@workspace/resupply-api-client";
import type { ListEpisodesParams } from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import {
  Badge,
  episodeStatusVariant,
  humanizeStatus,
} from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Pagination } from "../components/Pagination";
import { Label, Select } from "../components/Input";
import { Button } from "../components/Button";
import { fullName, formatDate } from "../lib/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListEpisodesStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

type Row = {
  id: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  itemSku: string;
  cadenceDays: number;
  status: string;
  dueAt: string;
  daysOverdue: number;
};

export function EpisodesPage() {
  const [location, setLocation] = useLocation();

  // Default to overdue queue — that's the operator's primary triage view.
  const initial = useMemo(
    () => readQueryParam(location, "status") ?? "overdue",
    [],
  );
  const [statusFilter, setStatusFilter] = useState<string>(initial);
  const [offset, setOffset] = useState<number>(0);

  useEffect(() => {
    setOffset(0);
  }, [statusFilter]);

  const params: ListEpisodesParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListEpisodesStatus }
        : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, offset],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListEpisodes(params, {
      query: {
        queryKey: getListEpisodesQueryKey(params),
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
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => `${r.cadenceDays}d`,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={episodeStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "due",
      header: "Due",
      render: (r) => (
        <div className="text-xs" style={{ color: "#374151" }}>
          {formatDate(r.dueAt)}
          {r.daysOverdue > 0 && (
            <div
              className="text-[10px] font-semibold mt-0.5"
              style={{ color: "#991b1b" }}
            >
              {r.daysOverdue}d overdue
            </div>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => <InlineActions row={r} />,
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "#0a1f44" }}
        >
          Episodes
        </h1>
        <p className="text-sm" style={{ color: "#374151" }}>
          Resupply queue. Defaults to overdue cycles awaiting outreach.
        </p>
      </header>

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="ep-status">Status</Label>
            <Select
              id="ep-status"
              value={statusFilter}
              emptyOptionLabel="All statuses"
              options={STATUS_OPTIONS}
              onChange={(e) => setStatusFilter(e.target.value)}
            />
          </div>
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading episodes…" />
          ) : (
            <>
              <Table
                columns={cols}
                rows={data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setLocation(`/patients/${r.patientId}`)}
                emptyState={
                  <EmptyState
                    title="No episodes match this view."
                    hint="Try the all-statuses view or check back later."
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

function InlineActions({ row }: { row: Row }) {
  const sms = useSendSmsReminder();
  const email = useSendEmailReminder();
  const voice = usePlaceVoiceCall();
  const isBusy = sms.isPending || email.isPending || voice.isPending;
  const data = { patientId: row.patientId, episodeId: row.id };
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        intent="primary"
        isLoading={sms.isPending}
        disabled={isBusy && !sms.isPending}
        onClick={(e) => {
          e.stopPropagation();
          void sms.mutateAsync({ data });
        }}
      >
        SMS
      </Button>
      <Button
        size="sm"
        intent="secondary"
        isLoading={email.isPending}
        disabled={isBusy && !email.isPending}
        onClick={(e) => {
          e.stopPropagation();
          void email.mutateAsync({ data });
        }}
      >
        Email
      </Button>
      <Button
        size="sm"
        intent="secondary"
        isLoading={voice.isPending}
        disabled={isBusy && !voice.isPending}
        onClick={(e) => {
          e.stopPropagation();
          void voice.mutateAsync({ data });
        }}
      >
        Call
      </Button>
    </div>
  );
}

function readQueryParam(location: string, key: string): string | null {
  const qIndex = location.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(location.slice(qIndex + 1)).get(key);
}
