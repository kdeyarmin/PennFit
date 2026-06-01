// /admin/analytics/margin — gross-margin / COGS dashboard (Owner #1).
//
// "The most important missing number." Reads the F1 cost snapshots and
// shows margin $ and % overall and by product. Cost is optional, so the
// page is explicit about its blind spot: it reports margin % over the
// revenue where cost is KNOWN and separately discloses the uncosted
// revenue, rather than averaging a guess into the headline.
//
// cost.read-gated server-side; the nav entry is shown to the finance
// team. Aggregates only — no per-order PHI.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchMarginReport,
  type MarginAggregate,
  type ProductMargin,
} from "@/lib/admin/analytics-margin-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
];

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function pct(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

function coverage(a: MarginAggregate): number | null {
  return a.revenueCents > 0 ? a.costedRevenueCents / a.revenueCents : null;
}

export function AdminAnalyticsMarginPage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: ["admin", "analytics", "margin", days] as const,
    queryFn: () => fetchMarginReport(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-analytics-margin-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <DollarSign className="h-6 w-6" />
            Margin &amp; COGS
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Gross margin after cost, by product and overall. Margin % is
            computed over the revenue where cost is recorded; revenue with no
            recorded cost is disclosed separately, never counted as pure margin.
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
        <Spinner label="Loading margin…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <HeadlineCards overall={query.data.overall} />
          <ByProductTable rows={query.data.byProduct} />
        </>
      )}
    </div>
  );
}

function HeadlineCards({ overall }: { overall: MarginAggregate }) {
  const cov = coverage(overall);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric
        label="Net margin"
        value={money(overall.marginCents)}
        hint="Over costed lines"
      />
      <Metric
        label="Margin %"
        value={pct(overall.marginRatio)}
        hint="Margin ÷ costed revenue"
      />
      <Metric
        label="Revenue"
        value={money(overall.revenueCents)}
        hint={`${overall.lineCount} line(s)`}
      />
      <Metric
        label="Cost coverage"
        value={pct(cov)}
        hint={
          overall.uncostedRevenueCents > 0
            ? `${money(overall.uncostedRevenueCents)} uncosted`
            : "all lines costed"
        }
        warn={overall.uncostedRevenueCents > 0}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
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
        <p
          className="text-[11px] mt-1"
          style={{ color: warn ? "#b45309" : "hsl(var(--ink-3))" }}
        >
          {hint}
        </p>
      )}
    </Card>
  );
}

function ByProductTable({ rows }: { rows: ProductMargin[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No paid order lines in this window.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[760px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Product</th>
            <th className="text-right px-3 py-2">Revenue</th>
            <th className="text-right px-3 py-2">Cost</th>
            <th className="text-right px-3 py-2">Margin</th>
            <th className="text-right px-3 py-2">Margin %</th>
            <th className="text-right px-3 py-2">Cost coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const cov = coverage(r);
            return (
              <tr
                key={r.productId}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2">
                  <div className="text-slate-900">
                    {r.productName ?? (
                      <span className="font-mono text-xs text-slate-500">
                        {r.productId}
                      </span>
                    )}
                  </div>
                  {r.productName && (
                    <div className="font-mono text-[11px] text-slate-400">
                      {r.productId}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(r.revenueCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.linesWithKnownCost > 0 ? money(r.costCents) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {r.linesWithKnownCost > 0 ? money(r.marginCents) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {pct(r.marginRatio)}
                </td>
                <td
                  className="px-3 py-2 text-right tabular-nums"
                  style={{
                    color:
                      cov != null && cov < 1 ? "#b45309" : "hsl(var(--ink-3))",
                  }}
                >
                  {pct(cov)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
