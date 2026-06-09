// /admin/analytics/acquisition-funnel — where patients drop out of the
// at-home fitter flow and the shop checkout flow, from the anonymous
// usage_events stream (Growth #G1, surfacing half).
//
// The customer SPA already instruments the whole funnel (lib/track.ts);
// this page is the readout that was missing. Conversion is by distinct
// session, so a stage showing 40% means 40% of the sessions that reached
// the top of that funnel also reached this stage. reports.read-gated
// server-side; anonymous sessions only — no PHI.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchAcquisitionFunnel,
  type AcquisitionFunnelResponse,
  type FunnelSummary,
} from "@/lib/admin/analytics-acquisition-funnel-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
];

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function AdminAnalyticsAcquisitionFunnelPage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: ["admin", "analytics", "acquisition-funnel", days],
    queryFn: () => fetchAcquisitionFunnel(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-analytics-acquisition-funnel-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Filter className="h-6 w-6" />
            Acquisition funnel
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Where anonymous visitors drop out of the at-home fitter flow and the
            shop checkout flow. Conversion is by distinct session.
          </p>
        </div>
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
      </header>

      {query.isPending ? (
        <Spinner label="Loading funnel…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <FunnelCard
            title="At-home fitter flow"
            subtitle="Home → consent → capture → measure → questionnaire → results → order"
            summary={query.data.fitter}
          />
          <FunnelCard
            title="Shop checkout flow"
            subtitle="Checkout started → step viewed → completed"
            summary={query.data.checkout}
          />
          <SignalsCard data={query.data} />
        </>
      )}
    </div>
  );
}

function FunnelCard({
  title,
  subtitle,
  summary,
}: {
  title: string;
  subtitle: string;
  summary: FunnelSummary;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2
            className="text-base font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {title}
          </h2>
          <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
            {subtitle}
          </p>
        </div>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Overall:{" "}
          <span
            className="font-semibold tabular-nums"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {pct(summary.overallConversion)}
          </span>
        </p>
      </div>
      {summary.topSessions === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No funnel activity in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Stage</th>
                <th className="text-right px-3 py-2">Sessions</th>
                <th className="text-right px-3 py-2">From previous</th>
                <th className="text-right px-3 py-2">From top</th>
                <th className="px-3 py-2 w-1/4">Reach</th>
              </tr>
            </thead>
            <tbody>
              {summary.stages.map((s) => {
                const fromTop = s.conversionFromTop ?? 0;
                const dropped =
                  s.conversionFromPrev != null && s.conversionFromPrev < 0.5;
                return (
                  <tr key={s.step} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-900">{s.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {num(s.sessions)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        dropped ? "text-red-600 font-semibold" : ""
                      }`}
                    >
                      {pct(s.conversionFromPrev)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {pct(s.conversionFromTop)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="h-2 rounded bg-slate-100 overflow-hidden">
                        <div
                          className="h-full rounded"
                          style={{
                            width: `${Math.round(fromTop * 100)}%`,
                            backgroundColor: "hsl(var(--penn-gold-deep))",
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function SignalsCard({ data }: { data: AcquisitionFunnelResponse }) {
  const signals = data.signals.filter((s) => s.events > 0);
  if (signals.length === 0) return null;
  return (
    <Card>
      <h2
        className="text-base font-semibold mb-1"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        Friction signals
      </h2>
      <p className="text-[11px] mb-3" style={{ color: "hsl(var(--ink-3))" }}>
        Non-sequential error / drop markers (raw event counts).
      </p>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {signals.map((s) => (
          <div key={s.step}>
            <p
              className="text-[10px] uppercase tracking-[0.15em] font-semibold"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {s.label}
            </p>
            <p
              className="text-xl font-semibold tabular-nums"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {num(s.events)}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}
