// /admin/analytics/revenue-by-source — order volume + cash revenue by
// channel (storefront cash-pay / insurance resupply / clinical form).
//
// Closed-loop measurement: "where do orders and revenue come from?"
// Pairs with /admin/analytics/outreach-attribution (which outreach
// converts) and the resupply funnel (episode flow). reports.read-gated
// server-side; aggregates only — no per-order PHI.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, PieChart } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchRevenueBySource,
  revenueBySourceCsvUrl,
  type RevenueBySourceResponse,
  type RevenueSourceBucket,
} from "@/lib/admin/analytics-revenue-by-source-api";

const WINDOWS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 365, label: "12 months" },
];

function money(cents: number | null): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function num(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function AdminAnalyticsRevenueBySourcePage() {
  const [days, setDays] = useState(30);

  const query = useQuery({
    queryKey: ["admin", "analytics", "revenue-by-source", days] as const,
    queryFn: () => fetchRevenueBySource(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-analytics-revenue-by-source-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PieChart className="h-6 w-6" />
            Revenue by source
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Order volume and cash revenue split across the three channels orders
            arrive through. Only the cash-pay storefront carries a dollar
            amount; insurance resupply and clinical-form orders are counted by
            volume.
          </p>
        </div>
        <div className="flex items-center gap-3">
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
          <a
            href={revenueBySourceCsvUrl(days)}
            download
            className="inline-flex items-center gap-1 rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </a>
        </div>
      </header>

      {query.isPending ? (
        <Spinner label="Loading revenue…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <HeadlineCards data={query.data} />
          <BySourceTable rows={query.data.bySource} />
        </>
      )}
    </div>
  );
}

function HeadlineCards({ data }: { data: RevenueBySourceResponse }) {
  const storefront = data.bySource.find((b) => b.source === "storefront");
  const resupply = data.bySource.find(
    (b) => b.source === "resupply_fulfillment",
  );
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric
        label="Cash revenue"
        value={money(data.totalCashRevenueCents)}
        hint="Storefront paid orders"
      />
      <Metric
        label="Total orders"
        value={num(data.totalOrders)}
        hint="All channels"
      />
      <Metric
        label="Storefront paid"
        value={num(storefront?.paidOrders ?? 0)}
        hint={`${num(storefront?.orders ?? 0)} created`}
      />
      <Metric
        label="Resupply units"
        value={num(resupply?.units ?? 0)}
        hint={`${num(resupply?.orders ?? 0)} fulfillment(s)`}
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

function BySourceTable({ rows }: { rows: RevenueSourceBucket[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No orders in this window.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Source</th>
            <th className="text-right px-3 py-2">Orders</th>
            <th className="text-right px-3 py-2">Units</th>
            <th className="text-right px-3 py-2">Paid orders</th>
            <th className="text-right px-3 py-2">Cash revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.source}
              className="border-t border-slate-100 hover:bg-slate-50"
            >
              <td className="px-3 py-2 text-slate-900">{r.label}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {num(r.orders)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {num(r.units)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {num(r.paidOrders)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {money(r.cashRevenueCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
