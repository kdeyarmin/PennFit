// /admin/billing/payer-profitability — net-yield by payer (Owner #2).
//
// "Are we making money with Payer X?" Per payer: billed → allowed →
// collected, current denial rate, and net of the F1 COGS captured on the
// claim lines. Cost is optional, so the page discloses cost coverage
// rather than treating an uncosted claim as zero-cost.
//
// cost.read-gated server-side; nav gated to match. Aggregates only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Landmark } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPayerProfitability,
  type PayerProfitability,
  type PayerProfitabilityResponse,
} from "@/lib/admin/payer-profitability-api";

const WINDOWS = [
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "12 months" },
  { value: 730, label: "24 months" },
];

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function pct(ratio: number | null): string {
  return ratio == null ? "—" : `${(ratio * 100).toFixed(1)}%`;
}

export function AdminPayerProfitabilityPage() {
  const [days, setDays] = useState(180);
  const query = useQuery({
    queryKey: ["admin", "payer-profitability", days] as const,
    queryFn: () => fetchPayerProfitability(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-payer-profitability-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Landmark className="h-6 w-6" />
            Payer profitability
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Net yield by payer: billed → allowed → collected, denial rate, and
            net of captured cost. Net is over the cost we can see — claims with
            no recorded COGS are disclosed, not assumed free.
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
        <Spinner label="Loading payer profitability…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <TotalsCards data={query.data} />
          <PayerTable payers={query.data.payers} />
        </>
      )}
    </div>
  );
}

function TotalsCards({ data }: { data: PayerProfitabilityResponse }) {
  const t = data.totals;
  const costCoverage =
    t.claimsWithCost + t.claimsWithoutCost > 0
      ? t.claimsWithCost / (t.claimsWithCost + t.claimsWithoutCost)
      : null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric
        label="Collected"
        value={money(t.paidCents)}
        hint={`${t.claimCount} claims`}
      />
      <Metric
        label="Net (of known COGS)"
        value={money(t.netCents)}
        hint={`COGS ${money(t.costKnownCents)}`}
      />
      <Metric
        label="Collection rate"
        value={pct(t.billedCents > 0 ? t.paidCents / t.billedCents : null)}
        hint={`billed ${money(t.billedCents)}`}
      />
      <Metric
        label="Cost coverage"
        value={pct(costCoverage)}
        hint={
          t.claimsWithoutCost > 0
            ? `${t.claimsWithoutCost} claims uncosted`
            : "all claims costed"
        }
        warn={t.claimsWithoutCost > 0}
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

function PayerTable({ payers }: { payers: PayerProfitability[] }) {
  if (payers.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No claims in this window.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Payer</th>
            <th className="text-right px-3 py-2">Claims</th>
            <th className="text-right px-3 py-2">Denial %</th>
            <th className="text-right px-3 py-2">Billed</th>
            <th className="text-right px-3 py-2">Collected</th>
            <th className="text-right px-3 py-2">Collection %</th>
            <th className="text-right px-3 py-2">COGS</th>
            <th className="text-right px-3 py-2">Net</th>
            <th className="text-right px-3 py-2">Net yield</th>
          </tr>
        </thead>
        <tbody>
          {payers.map((p) => (
            <tr
              key={p.payerKey}
              className="border-t border-slate-100 hover:bg-slate-50"
            >
              <td className="px-3 py-2">
                {p.payerName ?? (
                  <span className="font-mono text-xs text-slate-500">
                    {p.payerKey}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.claimCount}
              </td>
              <td
                className="px-3 py-2 text-right tabular-nums"
                style={{
                  color:
                    p.denialRate != null && p.denialRate > 0.1
                      ? "#b45309"
                      : "hsl(var(--ink-2))",
                }}
              >
                {pct(p.denialRate)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(p.billedCents)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(p.paidCents)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {pct(p.collectionRate)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.claimsWithCost > 0 ? money(p.costKnownCents) : "—"}
                {p.claimsWithoutCost > 0 && (
                  <span className="text-[10px] text-amber-700">
                    {" "}
                    ·{p.claimsWithoutCost} unc.
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {money(p.netCents)}
              </td>
              <td
                className="px-3 py-2 text-right tabular-nums"
                style={{
                  color:
                    p.netYieldRatio != null && p.netYieldRatio < 0
                      ? "#b91c1c"
                      : "hsl(var(--ink-1))",
                }}
              >
                {pct(p.netYieldRatio)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
