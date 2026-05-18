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

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CloudOff,
  Download,
  HeartPulse,
  RefreshCcw,
} from "lucide-react";
import { Link } from "wouter";

import { Card, KpiCard } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  fetchRtOverview,
  rtOverviewCsvUrl,
  type RtOverviewResponse,
  type RtOverviewRow,
} from "@/lib/admin/rt-overview-api";

const WINDOW_OPTIONS: { label: string; days: number }[] = [
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function AdminRtOverviewPage() {
  const [days, setDays] = useState(7);

  const query = useQuery<RtOverviewResponse>({
    queryKey: ["rt-overview", days],
    queryFn: () => fetchRtOverview(days),
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
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
            ? `${query.data.rows.length} tracked · window ${query.data.windowDays} days`
            : undefined
        }
      >
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
        ) : query.data && query.data.rows.length > 0 ? (
          <PatientTable rows={query.data.rows} />
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

function PatientTable({ rows }: { rows: RtOverviewRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-xs uppercase tracking-wider"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <Th>Patient</Th>
            <Th>Status</Th>
            <Th>Nights</Th>
            <Th>Last</Th>
            <Th align="right">AHI</Th>
            <Th align="right">Leak</Th>
            <Th align="right">Use (h)</Th>
            <Th>Sources</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <PatientRow key={r.patientId} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PatientRow({ row }: { row: RtOverviewRow }) {
  const isStale = row.nightsInWindow === 0;
  const hasAlerts = row.activeAlerts.length > 0;
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
          {row.lastName}, {row.firstName}
        </Link>
        <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {row.pacwareId}
        </div>
      </Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          {hasAlerts &&
            row.activeAlerts.map((a) => (
              <Badge key={a.kind} tone="gold" title={`Detected ${a.detectedAt}`}>
                <AlertTriangle className="w-3 h-3" />
                {a.label}
              </Badge>
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
