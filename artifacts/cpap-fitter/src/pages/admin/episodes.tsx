// Episodes — paginated resupply queue with the dispatcher's
// at-a-glance count strip + free-text search.
//
// Why a count strip + a status select coexist: the chips are the
// primary entry point ("Overdue 14, Awaiting 3, Confirmed 27 …")
// so a dispatcher sees queue depth without clicking; the legacy
// select stays as a precision filter when the chip you want isn't
// rendered (e.g. "expired" — rarely used but still selectable).
//
// URL contract: `?status=overdue&q=jane` so a saved view round-
// trips. Both params are debounced into local state and the chip
// strip + table read from local state, not the URL, so typing
// doesn't re-render every keystroke.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData } from "@tanstack/react-query";
import {
  EpisodesBulkSendRequestChannel,
  getListEpisodeCountsQueryKey,
  getListEpisodesQueryKey,
  ListEpisodesStatus,
  useBulkSendEpisodes,
  useListEpisodeCounts,
  useListEpisodes,
  useSendSmsReminder,
  useSendEmailReminder,
  usePlaceVoiceCall,
} from "@workspace/api-client-react/admin";
import type {
  EpisodeCounts,
  EpisodesBulkSendItemResult,
  EpisodesBulkSendResponse,
  ListEpisodesParams,
  ListEpisodeCountsParams,
} from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  episodeStatusVariant,
  humanizeStatus,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Pagination } from "@/components/admin/Pagination";
import { Label, Select } from "@/components/admin/Input";
import { Button } from "@/components/admin/Button";
import { fullName, formatDate } from "@/lib/admin/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListEpisodesStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

// The order of chips in the strip. We deliberately put the high-
// signal triage buckets first (overdue/outreach/awaiting) and
// "all" last so the eye lands on what's actionable, not on totals.
const COUNT_CHIPS: ReadonlyArray<{
  key: keyof EpisodeCounts;
  // Status value to push into the URL when the chip is clicked.
  // `null` clears the status filter (used by "All").
  status: string | null;
  label: string;
  // Tone hints for at-a-glance recognition.
  tone: "danger" | "warn" | "primary" | "muted";
}> = [
  { key: "overdue", status: "overdue", label: "Overdue", tone: "danger" },
  {
    key: "outreach_pending",
    status: "outreach_pending",
    label: "Outreach",
    tone: "warn",
  },
  {
    key: "awaiting_response",
    status: "awaiting_response",
    label: "Awaiting reply",
    tone: "warn",
  },
  {
    key: "confirmed",
    status: "confirmed",
    label: "Confirmed",
    tone: "primary",
  },
  { key: "fulfilled", status: "fulfilled", label: "Fulfilled", tone: "muted" },
  { key: "declined", status: "declined", label: "Declined", tone: "muted" },
  { key: "expired", status: "expired", label: "Expired", tone: "muted" },
  { key: "canceled", status: "canceled", label: "Canceled", tone: "muted" },
  { key: "all", status: null, label: "All", tone: "muted" },
];

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

  // Default to overdue queue — that's the admin's primary triage view.
  // Empty deps are deliberate: only the first-mount URL seeds state;
  // the local filter UI takes over from then on.
  const initialStatus = useMemo(
    () => readQueryParam(location, "status") ?? "overdue",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialQ = useMemo(() => readQueryParam(location, "q") ?? "", []);
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  // Two q states: the live input (re-renders on every keystroke) and
  // the debounced value used to drive the network calls. 250ms is the
  // sweet spot — fast enough that pagination/results feel
  // synchronous on a good connection, slow enough to swallow
  // burst-typing.
  const [qInput, setQInput] = useState<string>(initialQ);
  const [qDebounced, setQDebounced] = useState<string>(initialQ);
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(qInput), 250);
    return () => clearTimeout(t);
  }, [qInput]);

  const [offset, setOffset] = useState<number>(0);

  // Multi-select state for the bulk-send toolbar. Cleared on every
  // filter / pagination change so the dispatcher never accidentally
  // dispatches reminders to rows they can no longer see (which
  // would otherwise be a "what did I just send to?!" footgun).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkChannel, setBulkChannel] =
    useState<EpisodesBulkSendRequestChannel>("sms");
  const [lastBulkResult, setLastBulkResult] =
    useState<EpisodesBulkSendResponse | null>(null);

  // Reset pagination whenever the filter set changes — otherwise a
  // user paging deep into "overdue" then switching to "fulfilled"
  // would see a phantom "no rows" screen on a perfectly populated
  // page.
  useEffect(() => {
    setOffset(0);
    setSelected(new Set());
    setLastBulkResult(null);
  }, [statusFilter, qDebounced]);

  // Clear selection on page change too — the new page's rows are
  // a different slate, and carrying selection across pages would
  // hide checked rows from view.
  useEffect(() => {
    setSelected(new Set());
  }, [offset]);

  // Keep the URL in sync with the debounced filter so a refresh /
  // tab share preserves the view. We use `replace` (no history
  // entry) so back/forward doesn't accumulate one entry per
  // keystroke.
  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (qDebounced) params.set("q", qDebounced);
    const qs = params.toString();
    setLocation(qs ? `/admin/episodes?${qs}` : "/admin/episodes", {
      replace: true,
    });
  }, [statusFilter, qDebounced, setLocation]);

  const params: ListEpisodesParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListEpisodesStatus }
        : {}),
      ...(qDebounced ? { q: qDebounced } : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, qDebounced, offset],
  );

  const countsParams: ListEpisodeCountsParams = useMemo(
    () => (qDebounced ? { q: qDebounced } : {}),
    [qDebounced],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListEpisodes(params, {
      query: {
        queryKey: getListEpisodesQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  // Counts query: same q filter so chips reflect the same row-set.
  // We tolerate failure (errors render the chips as "—") because
  // the table itself is the primary surface; a counts hiccup
  // shouldn't blank the page.
  const counts = useListEpisodeCounts(countsParams, {
    query: {
      queryKey: getListEpisodeCountsQueryKey(countsParams),
      placeholderData: keepPreviousData,
      staleTime: 30_000,
    },
  });

  const bulkSend = useBulkSendEpisodes();

  const visibleIds = useMemo(
    () => (data?.items ?? []).map((r) => r.id),
    [data],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected =
    !allVisibleSelected && visibleIds.some((id) => selected.has(id));

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cols: Column<Row>[] = [
    {
      key: "select",
      header: (
        <input
          type="checkbox"
          aria-label="Select all visible episodes"
          data-testid="episodes-select-all"
          checked={allVisibleSelected}
          ref={(el) => {
            if (el) el.indeterminate = someVisibleSelected;
          }}
          onChange={toggleAllVisible}
          onClick={(e) => e.stopPropagation()}
          className="cursor-pointer"
        />
      ),
      className: "w-8",
      render: (r) => (
        <input
          type="checkbox"
          aria-label={`Select episode ${r.id}`}
          data-testid={`episodes-select-${r.id}`}
          checked={selected.has(r.id)}
          onChange={() => toggleOne(r.id)}
          onClick={(e) => e.stopPropagation()}
          className="cursor-pointer"
        />
      ),
    },
    {
      key: "patient",
      header: "Patient",
      render: (r) => (
        <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
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
        <div className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
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
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Episodes
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Resupply queue. Defaults to overdue cycles awaiting outreach.
        </p>
      </header>

      <CountStrip
        active={statusFilter}
        counts={counts.data ?? null}
        loading={counts.isPending}
        onPick={(next) => setStatusFilter(next ?? "")}
      />

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="sm:col-span-2">
            <Label htmlFor="ep-q">Search</Label>
            <input
              id="ep-q"
              type="search"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Patient name, patient id, or episode id"
              maxLength={64}
              autoComplete="off"
              data-testid="episodes-search-input"
              className="block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Substring match on the patient name (case-insensitive), or paste
              an exact patient/episode id.
            </p>
          </div>
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

      <BulkSendToolbar
        selectedCount={selected.size}
        channel={bulkChannel}
        onChannelChange={setBulkChannel}
        onClear={() => {
          setSelected(new Set());
          setLastBulkResult(null);
        }}
        onSend={async () => {
          const ids = Array.from(selected);
          if (ids.length === 0) return;
          setLastBulkResult(null);
          try {
            const r = await bulkSend.mutateAsync({
              data: { episodeIds: ids, channel: bulkChannel },
            });
            setLastBulkResult(r);
            // Clear selection only for ids that succeeded so the
            // dispatcher can re-attempt the failures with one click.
            const okIds = new Set(
              r.results
                .filter((x) => x.status === "ok")
                .map((x) => x.episodeId),
            );
            setSelected((prev) => {
              const next = new Set(prev);
              for (const id of okIds) next.delete(id);
              return next;
            });
          } catch (err) {
            setLastBulkResult({
              summary: { total: ids.length, sent: 0, failed: ids.length },
              results: ids.map<EpisodesBulkSendItemResult>((id) => ({
                episodeId: id,
                status: "error",
                error: "request_failed",
                message: err instanceof Error ? err.message : String(err),
              })),
            });
          }
        }}
        isPending={bulkSend.isPending}
        result={lastBulkResult}
      />

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
                onRowClick={(r) =>
                  setLocation(`/admin/patients/${r.patientId}`)
                }
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

// CountStrip renders one chip per status with its current count.
// Chips are buttons (keyboard accessible) — clicking sets the
// status filter. The active chip gets a darker fill so the
// dispatcher can see at a glance which view they're in.
function CountStrip({
  active,
  counts,
  loading,
  onPick,
}: {
  active: string;
  counts: EpisodeCounts | null;
  loading: boolean;
  onPick: (next: string | null) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Filter episodes by status"
      data-testid="episodes-count-strip"
    >
      {COUNT_CHIPS.map((chip) => {
        const isActive =
          chip.status === null ? active === "" : active === chip.status;
        const value = counts ? counts[chip.key] : null;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onPick(chip.status)}
            data-testid={`episodes-chip-${chip.key}`}
            aria-pressed={isActive}
            className={chipClass(chip.tone, isActive)}
          >
            <span className="font-medium">{chip.label}</span>
            <span
              className={`ml-2 inline-flex items-center justify-center min-w-[1.5rem] px-1.5 rounded text-xs font-semibold ${
                isActive
                  ? "bg-white/20 text-white"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {loading && value === null
                ? "…"
                : value === null
                  ? "—"
                  : value.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function chipClass(
  tone: "danger" | "warn" | "primary" | "muted",
  active: boolean,
): string {
  // Active state mostly inverts: solid fill in the tone color so
  // it pops against neutral siblings. Inactive uses an outline +
  // tone-tinted text so the row stays calm at rest.
  const base =
    "inline-flex items-center px-3 py-1.5 rounded-full text-sm transition-colors border focus:outline-none focus:ring-2 focus:ring-slate-400";
  if (active) {
    if (tone === "danger")
      return `${base} bg-rose-600 text-white border-rose-700 hover:bg-rose-700`;
    if (tone === "warn")
      return `${base} bg-amber-500 text-white border-amber-600 hover:bg-amber-600`;
    if (tone === "primary")
      return `${base} text-white border-[#0a1f44] hover:opacity-90 bg-[#0a1f44]`;
    return `${base} bg-slate-700 text-white border-slate-800 hover:bg-slate-800`;
  }
  if (tone === "danger")
    return `${base} bg-white text-rose-700 border-rose-200 hover:bg-rose-50`;
  if (tone === "warn")
    return `${base} bg-white text-amber-700 border-amber-200 hover:bg-amber-50`;
  if (tone === "primary")
    return `${base} bg-white border-slate-200 hover:bg-slate-50 text-[#0a1f44]`;
  return `${base} bg-white text-slate-700 border-slate-200 hover:bg-slate-50`;
}

// Bulk-send toolbar. Renders a sticky-feeling bar between the
// filter card and the table whenever any episode is selected, plus
// a one-time result banner after the dispatcher hits "Send N
// reminders." We do NOT use a toast: the result list can be long
// (up to 50 per-id outcomes) and the dispatcher needs to scan it
// in place.
function BulkSendToolbar({
  selectedCount,
  channel,
  onChannelChange,
  onClear,
  onSend,
  isPending,
  result,
}: {
  selectedCount: number;
  channel: EpisodesBulkSendRequestChannel;
  onChannelChange: (next: EpisodesBulkSendRequestChannel) => void;
  onClear: () => void;
  onSend: () => Promise<void> | void;
  isPending: boolean;
  result: EpisodesBulkSendResponse | null;
}) {
  if (selectedCount === 0 && !result) return null;

  return (
    <div className="space-y-3">
      {selectedCount > 0 && (
        <div
          className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-md border"
          style={{
            backgroundColor: "#f8fafc",
            borderColor: "#cbd5e1",
            color: "hsl(var(--ink-1))",
          }}
          data-testid="episodes-bulk-toolbar"
        >
          <span className="text-sm font-medium">{selectedCount} selected</span>
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Channel:
          </span>
          <Select
            id="episodes-bulk-channel"
            value={channel}
            options={[
              { value: "sms", label: "SMS" },
              { value: "email", label: "Email" },
            ]}
            onChange={(e) =>
              onChannelChange(e.target.value as EpisodesBulkSendRequestChannel)
            }
            className="!py-1 !text-xs !w-auto"
          />
          <Button
            size="sm"
            intent="primary"
            isLoading={isPending}
            disabled={isPending}
            onClick={() => void onSend()}
            data-testid="episodes-bulk-send-button"
          >
            Send {selectedCount} {channel === "sms" ? "SMS" : "email"}
            {selectedCount === 1 ? "" : "s"}
          </Button>
          <Button
            size="sm"
            intent="ghost"
            disabled={isPending}
            onClick={onClear}
          >
            Clear
          </Button>
        </div>
      )}

      {result && <BulkSendResultBanner result={result} />}
    </div>
  );
}

function BulkSendResultBanner({
  result,
}: {
  result: EpisodesBulkSendResponse;
}) {
  const failures = result.results.filter((r) => r.status === "error");
  const tone =
    result.summary.failed === 0
      ? "ok"
      : result.summary.sent === 0
        ? "error"
        : "mixed";
  const bg =
    tone === "ok" ? "#ecfdf5" : tone === "error" ? "#fef2f2" : "#fffbeb";
  const border =
    tone === "ok" ? "#a7f3d0" : tone === "error" ? "#fecaca" : "#fde68a";
  const fg =
    tone === "ok" ? "#065f46" : tone === "error" ? "#991b1b" : "#854d0e";

  return (
    <div
      className="px-4 py-3 rounded-md border text-sm"
      style={{ backgroundColor: bg, borderColor: border, color: fg }}
      data-testid="episodes-bulk-result"
    >
      <div className="font-semibold">
        {result.summary.sent} sent · {result.summary.failed} failed
      </div>
      {failures.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs">
            Show {failures.length} failure{failures.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {failures.map((f) => (
              <li key={f.episodeId}>
                <code>{f.episodeId.slice(0, 8)}…</code>{" "}
                <span className="font-medium">{f.error ?? "unknown"}</span>
                {f.message ? <> — {f.message}</> : null}
              </li>
            ))}
          </ul>
        </details>
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
