// /admin/analytics/outreach-attribution — of the patients we proactively
// contacted (reminders / clinical outreach) in the window, the share who
// placed a resupply order within N days of that contact, by channel.
//
// Closed-loop measurement: "which outreach actually converts?" Pairs with
// /admin/analytics/revenue-by-source (where revenue comes from) and the
// resupply funnel (episode flow). reports.read-gated server-side;
// aggregates only — no per-patient PHI.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Target } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchOutreachAttribution,
  outreachAttributionCsvUrl,
  type AttributionBucket,
  type OutreachAttributionResponse,
} from "@/lib/admin/analytics-outreach-attribution-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
];

const ATTRIBUTION_WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
];

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function AdminAnalyticsOutreachAttributionPage() {
  const [days, setDays] = useState(90);
  const [attrWindow, setAttrWindow] = useState(14);

  const query = useQuery({
    queryKey: ["admin", "analytics", "outreach-attribution", days, attrWindow],
    queryFn: () => fetchOutreachAttribution(days, attrWindow),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-analytics-outreach-attribution-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Target className="h-6 w-6" />
            Outreach attribution
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Of the patients we proactively contacted, the share who placed a
            resupply order within the attribution window — by channel. First-
            touch: a patient is credited to their earliest contact.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Window
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Attribution
            <select
              value={attrWindow}
              onChange={(e) => setAttrWindow(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {ATTRIBUTION_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <a
            href={outreachAttributionCsvUrl(days, attrWindow)}
            download
            className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
        </div>
      </header>

      {query.isPending ? (
        <Spinner label="Loading attribution…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <HeadlineCards data={query.data} />
          <BySourceTable rows={[...query.data.bySource, query.data.overall]} />
        </>
      )}
    </div>
  );
}

function HeadlineCards({ data }: { data: OutreachAttributionResponse }) {
  const o = data.overall;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric
        label="Patients contacted"
        value={num(o.contactedPatients)}
        hint="Any channel (de-duped)"
      />
      <Metric
        label="Converted"
        value={num(o.convertedPatients)}
        hint={`Ordered within ${data.attributionWindowDays}d`}
      />
      <Metric
        label="Conversion rate"
        value={pct(o.conversionRate)}
        hint="Converted ÷ contacted"
      />
      <Metric
        label="Attribution window"
        value={`${data.attributionWindowDays}d`}
        hint={`Over a ${data.windowDays}d contact window`}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </p>
      {hint && (
        <p className="text-[11px] mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </p>
      )}
    </Card>
  );
}

function BySourceTable({ rows }: { rows: AttributionBucket[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No outreach in this window.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[620px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Channel</th>
            <th className="text-right px-3 py-2">Contacted</th>
            <th className="text-right px-3 py-2">Converted</th>
            <th className="text-right px-3 py-2">Conversion rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.source}
              className={
                r.source === "overall"
                  ? "border-t-2 border-slate-300 font-semibold"
                  : "border-t border-slate-100 hover:bg-slate-50"
              }
            >
              <td className="px-3 py-2 text-slate-900">{r.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {num(r.contactedPatients)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {num(r.convertedPatients)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {pct(r.conversionRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
