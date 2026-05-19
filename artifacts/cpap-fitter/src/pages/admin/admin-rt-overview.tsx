// /admin/rt-overview — respiratory therapist at-a-glance board.
//
// One screen, three sections:
//   1. Top KPI strip — active / alerting / stale counts.
//   2. Window selector (7/14/30/90 days) + CSV download button.
//   3. Patient table sorted alerting-first, then by name.
//
// Reads /admin/rt-overview (server-side joins patient_therapy_links,
// patient_therapy_nights, patient_smart_trigger_events). No charts:
// the RT team's daily workflow is "scan, click into the patient that
// looks off." A chart would slow that down. Trending lives on the
// per-patient detail page; this view is for triage.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CloudOff,
  Download,
  HeartPulse,
  RefreshCcw,
  Search,
  X,
} from "lucide-react";
import { Link } from "wouter";

import { Card, KpiCard } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createRtFilterDefault,
  distinctSources,
  dismissSmartTrigger,
  fetchRtOverview,
  filterRtRows,
  rtOverviewCsvUrl,
  sortRtRows,
  type RtFilter,
  type RtOverviewAlert,
  type RtOverviewResponse,
  type RtOverviewRow,
  type RtSortDir,
  type RtSortKey,
} from "@/lib/admin/rt-overview-api";

const WINDOW_OPTIONS: { label: string; days: number }[] = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function AdminRtOverviewPage() {
  const [days, setDays] = useState(7);
  const [sortKey, setSortKey] = useState<RtSortKey>("default");
  const [sortDir, setSortDir] = useState<RtSortDir>("desc");
  const [filter, setFilter] = useState<RtFilter>(() => createRtFilterDefault());
  const queryClient = useQueryClient();

  const query = useQuery<RtOverviewResponse>({
    queryKey: ["rt-overview", days],
    queryFn: () => fetchRtOverview(days),
  });

  const dismissMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string | null }) =>
      dismissSmartTrigger(id, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rt-overview"] });
    },
  });

  /**
   * Inline dismiss handler. The RT confirms the dismiss + optionally
   * captures a one-line reason ("called pt, mask refit booked",
   * "duplicate of earlier event", etc.) which lands in the audit
   * trail via the existing /admin/smart-triggers/:id/dismiss endpoint.
   * The prompt() flow is intentionally minimal — closing the loop on
   * the board is the win; a fancier modal can land later.
   */
  const handleDismiss = (alert: RtOverviewAlert, patientName: string) => {
    const reason = window.prompt(
      `Dismiss "${alert.label}" for ${patientName}?\n\n` +
        `Optional reason (logged for audit; leave blank to skip):`,
      "",
    );
    // prompt() returns null when the user cancels; treat that as
    // a cancel, not as an empty-reason dismiss.
    if (reason === null) return;
    dismissMutation.mutate({
      id: alert.id,
      reason: reason.trim() || null,
    });
  };

  /**
   * Click a header to sort by that column. Clicking the same header
   * again toggles direction; clicking a different header keeps the
   * current direction (RTs tend to want "worst first" across every
   * metric, so preserving direction across switches matches that).
   * The 9th click of the same header returns to default (server)
   * order so there's a clear path back.
   */
  const onHeaderClick = (key: RtSortKey) => {
    if (sortKey === key) {
      // toggle: current desc → asc; current asc → default.
      if (sortDir === "desc") setSortDir("asc");
      else setSortKey("default");
    } else {
      setSortKey(key);
      // Reset to descending for the new column. "Worst first" is what
      // the RT almost always wants when they click a metric header.
      setSortDir("desc");
    }
  };

  /**
   * filter → sort. Order matters: dropping rows first means the
   * comparator sees less data. For a 200-patient board it's a wash
   * but the composition is the clearer mental model regardless.
   *
   * `sources` for the filter chip strip comes from the unfiltered
   * fleet — if we derived it from the post-filter rows, applying a
   * source filter would shrink the chip list to just the chosen one
   * and the user couldn't un-toggle to a different source from there.
   */
  const allSources = useMemo(
    () => (query.data ? distinctSources(query.data.rows) : []),
    [query.data],
  );
  const visibleRows = useMemo(() => {
    if (!query.data) return [];
    const filtered = filterRtRows(query.data.rows, filter);
    return sortRtRows(filtered, sortKey, sortDir);
  }, [query.data, filter, sortKey, sortDir]);

  const totalRows = query.data?.rows.length ?? 0;
  const filterIsActive =
    filter.alertingOnly ||
    filter.staleOnly ||
    filter.sources.size > 0 ||
    filter.search.trim().length > 0;

  const toggleSource = (source: string) => {
    setFilter((prev) => {
      const next = new Set(prev.sources);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return { ...prev, sources: next };
    });
  };

  return (
    <div className="admin-root p-6 space-y-6 max-w-6xl">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">RT overview</h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Daily clinical board for tracked patients across ResMed
            AirView, Philips Care Orchestrator, React Health, and
            Google Health Connect. Alerting rows sort to the top.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WindowSelector value={days} onChange={setDays} />
          <a href={rtOverviewCsvUrl(days)} target="_blank" rel="noreferrer">
            <Button intent="secondary" size="sm">
              <Download className="w-4 h-4 mr-1.5" />
              Export CSV
            </Button>
          </a>
          <Button
            intent="secondary"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCcw
              className={`w-4 h-4 mr-1.5 ${query.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <KpiCard
          label="Active"
          value={query.data?.summary.totalActive ?? 0}
          hint={`with ≥1 night in last ${days}d`}
          isLoading={query.isLoading}
          tone="navy"
        />
        <KpiCard
          label="Alerting"
          value={query.data?.summary.totalAlerting ?? 0}
          hint="undismissed smart-trigger events"
          isLoading={query.isLoading}
          tone="gold"
        />
        <KpiCard
          label="Stale"
          value={query.data?.summary.totalStale ?? 0}
          hint="linked but no recent night"
          isLoading={query.isLoading}
          tone="navy"
        />
      </div>

      <Card
        title="Patients"
        subtitle={
          query.data
            ? filterIsActive
              ? `${visibleRows.length} of ${totalRows} tracked · window ${query.data.windowDays} days`
              : `${totalRows} tracked · window ${query.data.windowDays} days`
            : undefined
        }
      >
        {query.data && totalRows > 0 && (
          <FilterBar
            filter={filter}
            onFilterChange={setFilter}
            allSources={allSources}
            onToggleSource={toggleSource}
          />
        )}
        {query.isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner />
          </div>
        ) : query.isError ? (
          <ErrorPanel
            title="Couldn't load the RT board"
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : query.data && totalRows > 0 ? (
          visibleRows.length > 0 ? (
            <PatientTable
              rows={visibleRows}
              sortKey={sortKey}
              sortDir={sortDir}
              onHeaderClick={onHeaderClick}
              onDismiss={handleDismiss}
            />
          ) : (
            <p
              className="text-sm py-6 text-center"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              No patients match the current filters.{" "}
              <button
                type="button"
                onClick={() => setFilter(createRtFilterDefault())}
                className="underline"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                Clear filters
              </button>
              .
            </p>
          )
        ) : (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No patients have an active therapy link yet. Once an
            integration is connected and the nightly sync runs, rows
            appear here automatically.
          </p>
        )}
      </Card>
    </div>
  );
}

function WindowSelector({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md border overflow-hidden text-xs"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      {WINDOW_OPTIONS.map((opt, i) => (
        <button
          key={opt.days}
          onClick={() => onChange(opt.days)}
          className={`px-2.5 py-1.5 ${
            value === opt.days ? "font-semibold" : ""
          } ${i > 0 ? "border-l" : ""}`}
          style={{
            borderColor: "hsl(var(--line-1))",
            background:
              value === opt.days
                ? "hsl(var(--penn-mist))"
                : "transparent",
            color:
              value === opt.days
                ? "hsl(var(--penn-navy))"
                : "hsl(var(--ink-2))",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Filter bar above the patient table. Pure controlled component —
 * no internal filter state, no debouncing. Search is filtered as you
 * type because the underlying data is already in memory and the
 * filter is cheap; debouncing would just add latency.
 */
function FilterBar({
  filter,
  onFilterChange,
  allSources,
  onToggleSource,
}: {
  filter: RtFilter;
  onFilterChange: (next: RtFilter) => void;
  allSources: string[];
  onToggleSource: (source: string) => void;
}) {
  const filterIsActive =
    filter.alertingOnly ||
    filter.staleOnly ||
    filter.sources.size > 0 ||
    filter.search.trim().length > 0;
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: "hsl(var(--ink-3))" }}
          />
          <Input
            type="search"
            placeholder="Search name or pacware id…"
            value={filter.search}
            onChange={(e) =>
              onFilterChange({ ...filter, search: e.target.value })
            }
            className="pl-8"
            aria-label="Search patients"
          />
        </div>
        <FilterChip
          active={filter.alertingOnly}
          onClick={() =>
            onFilterChange({ ...filter, alertingOnly: !filter.alertingOnly })
          }
        >
          Alerting only
        </FilterChip>
        <FilterChip
          active={filter.staleOnly}
          onClick={() =>
            onFilterChange({ ...filter, staleOnly: !filter.staleOnly })
          }
        >
          Stale only
        </FilterChip>
        {filterIsActive && (
          <button
            type="button"
            onClick={() => onFilterChange(createRtFilterDefault())}
            className="text-xs underline ml-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Clear all
          </button>
        )}
      </div>
      {allSources.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="text-xs uppercase tracking-wider"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Source:
          </span>
          {allSources.map((s) => (
            <FilterChip
              key={s}
              active={filter.sources.has(s)}
              onClick={() => onToggleSource(s)}
            >
              {s}
            </FilterChip>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterChip({
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
      onClick={onClick}
      aria-pressed={active}
      className="px-2.5 py-1 text-xs rounded-full border transition-colors"
      style={{
        borderColor: active
          ? "hsl(var(--penn-navy))"
          : "hsl(var(--line-1))",
        background: active
          ? "hsla(var(--penn-navy) / 0.1)"
          : "transparent",
        color: active ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}

function PatientTable({
  rows,
  sortKey,
  sortDir,
  onHeaderClick,
  onDismiss,
}: {
  rows: RtOverviewRow[];
  sortKey: RtSortKey;
  sortDir: RtSortDir;
  onHeaderClick: (key: RtSortKey) => void;
  onDismiss: (alert: RtOverviewAlert, patientName: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-xs uppercase tracking-wider"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <SortableTh
              sortKey="patient"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
            >
              Patient
            </SortableTh>
            <SortableTh
              sortKey="alerts"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
            >
              Status
            </SortableTh>
            <SortableTh
              sortKey="nights"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
              align="left"
            >
              Nights
            </SortableTh>
            <SortableTh
              sortKey="lastNight"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
            >
              Last
            </SortableTh>
            <SortableTh
              sortKey="ahi"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
              align="right"
            >
              AHI
            </SortableTh>
            <SortableTh
              sortKey="leak"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
              align="right"
            >
              Leak
            </SortableTh>
            <SortableTh
              sortKey="usage"
              activeKey={sortKey}
              dir={sortDir}
              onClick={onHeaderClick}
              align="right"
            >
              Use (h)
            </SortableTh>
            <Th>Sources</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <PatientRow key={r.patientId} row={r} onDismiss={onDismiss} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Header that toggles a column's sort. Shows an arrow when this
 * column is the active sort key. Single-button design keeps the
 * table header keyboard-navigable without nesting interactive
 * elements (a clickable `<th>` content + a separate sort icon button
 * would be two tab stops per column, which gets noisy fast on an
 * eight-column table).
 */
function SortableTh({
  sortKey,
  activeKey,
  dir,
  onClick,
  align = "left",
  children,
}: {
  sortKey: RtSortKey;
  activeKey: RtSortKey;
  dir: RtSortDir;
  onClick: (key: RtSortKey) => void;
  align?: "left" | "right";
  children: React.ReactNode;
}) {
  const isActive = activeKey === sortKey;
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={`px-3 py-2 text-${align} font-medium`}>
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={`inline-flex items-center gap-1 text-xs uppercase tracking-wider ${
          isActive ? "font-semibold" : "font-medium"
        }`}
        style={{
          color: isActive
            ? "hsl(var(--penn-navy))"
            : "hsl(var(--ink-3))",
        }}
        aria-sort={
          isActive ? (dir === "asc" ? "ascending" : "descending") : "none"
        }
      >
        {children}
        {isActive && <Icon className="w-3 h-3" />}
      </button>
    </th>
  );
}

function PatientRow({
  row,
  onDismiss,
}: {
  row: RtOverviewRow;
  onDismiss: (alert: RtOverviewAlert, patientName: string) => void;
}) {
  const isStale = row.nightsInWindow === 0;
  const hasAlerts = row.activeAlerts.length > 0;
  const patientName = `${row.lastName}, ${row.firstName}`;
  return (
    <tr
      className="border-t"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <Td>
        <Link
          href={`/admin/patients/${row.patientId}`}
          className="font-medium hover:underline"
        >
          {patientName}
        </Link>
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {row.pacwareId}
        </div>
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {hasAlerts &&
            row.activeAlerts.map((a) => (
              <AlertBadge
                key={a.id}
                alert={a}
                onDismiss={() => onDismiss(a, patientName)}
              />
            ))}
          {isStale && !hasAlerts && (
            <Badge tone="muted">
              <CloudOff className="w-3 h-3" />
              {row.staleDays === null
                ? "No nights"
                : `Stale ${row.staleDays}d`}
            </Badge>
          )}
          {!isStale && !hasAlerts && (
            <Badge tone="navy">
              <HeartPulse className="w-3 h-3" />
              OK
            </Badge>
          )}
        </div>
      </Td>
      <Td>{row.nightsInWindow}</Td>
      <Td>{row.lastNightDate ?? "—"}</Td>
      <Td align="right" mono>
        {row.ahiAvg === null ? "—" : row.ahiAvg.toFixed(1)}
      </Td>
      <Td align="right" mono>
        {row.leakAvg === null ? "—" : row.leakAvg.toFixed(1)}
      </Td>
      <Td align="right" mono>
        {row.usageMinutesAvg === null
          ? "—"
          : (row.usageMinutesAvg / 60).toFixed(1)}
      </Td>
      <Td>
        <span style={{ color: "hsl(var(--ink-3))" }}>
          {row.therapyLinks.map((l) => l.source).join(", ") || "—"}
        </span>
      </Td>
    </tr>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th className={`px-3 py-2 text-${align} font-medium`}>{children}</th>
  );
}

function Td({
  children,
  align = "left",
  mono = false,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  mono?: boolean;
}) {
  return (
    <td
      className={`px-3 py-2 text-${align} align-top ${
        mono ? "tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}

/**
 * Alert badge with an inline dismiss button. The badge itself shows
 * the trigger kind + the detected timestamp on hover; the trailing
 * `x` opens a confirmation prompt and POSTs to the existing dismiss
 * endpoint. The dismiss button is intentionally not announced to
 * screen readers as a separate landmark — it's a per-row action; the
 * aria-label carries the alert context so a SR user knows what's
 * being dismissed.
 */
function AlertBadge({
  alert,
  onDismiss,
}: {
  alert: RtOverviewAlert;
  onDismiss: () => void;
}) {
  return (
    <span
      title={`Detected ${alert.detectedAt}`}
      className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium"
      style={{
        background: "hsla(var(--penn-gold-deep) / 0.12)",
        color: "hsl(var(--penn-gold-deep))",
      }}
    >
      <AlertTriangle className="w-3 h-3" />
      {alert.label}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Dismiss ${alert.label} alert`}
        className="ml-0.5 inline-flex items-center justify-center w-4 h-4 rounded-full hover:bg-black/10 focus-visible:outline-none focus-visible:ring-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}

function Badge({
  children,
  tone = "navy",
  title,
}: {
  children: React.ReactNode;
  tone?: "navy" | "gold" | "muted";
  title?: string;
}) {
  const bg =
    tone === "gold"
      ? "hsla(var(--penn-gold-deep) / 0.12)"
      : tone === "muted"
        ? "hsl(var(--line-1))"
        : "hsla(var(--penn-navy) / 0.08)";
  const fg =
    tone === "gold"
      ? "hsl(var(--penn-gold-deep))"
      : tone === "muted"
        ? "hsl(var(--ink-3))"
        : "hsl(var(--penn-navy))";
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}
