// /admin/analytics/inventory-turnover — inventory turnover & stockout
// cost (Owner #7).
//
// Turnover = annualized COGS ÷ inventory value per SKU; inventory value
// uses the latest reconciliation count × latest captured unit cost. A
// SKU with no reconciliation shows turnover "—" (honest, not a guess).
// Stockout cost = open back-in-stock waiters × latest price.
//
// cost.read-gated server-side; nav gated to match. Aggregates only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchInventoryTurnover,
  type InventoryTurnoverResponse,
  type InvProductRow,
} from "@/lib/admin/inventory-turnover-api";

const WINDOWS = [
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "12 months" },
];

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function turns(t: number | null): string {
  return t == null ? "—" : `${t.toFixed(1)}×`;
}

export function AdminInventoryTurnoverPage() {
  const [days, setDays] = useState(90);
  const query = useQuery({
    queryKey: ["admin", "inventory-turnover", days] as const,
    queryFn: () => fetchInventoryTurnover(days),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-inventory-turnover-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Boxes className="h-6 w-6" />
            Inventory turnover
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Annualized COGS ÷ inventory value per SKU, with the demand parked on
            stockouts. Turnover needs an inventory count — SKUs with no
            reconciliation on file show "—" rather than a guessed number.
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
        <Spinner label="Loading turnover…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <TotalsCards data={query.data} />
          <ProductTable products={query.data.products} />
        </>
      )}
    </div>
  );
}

function TotalsCards({ data }: { data: InventoryTurnoverResponse }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric label="Inventory value" value={money(t.inventoryValueCents)} />
      <Metric
        label="Blended turnover"
        value={turns(t.turnover)}
        hint="per year"
      />
      <Metric
        label="Annualized COGS"
        value={money(t.annualizedCogsCents)}
        hint={`${data.windowDays}-day window`}
      />
      <Metric
        label="Stockout demand"
        value={money(t.stockoutDemandCents)}
        hint={
          t.productsWithoutReconciliation > 0
            ? `${t.productsWithoutReconciliation} SKUs uncounted`
            : "all SKUs counted"
        }
        warn={t.productsWithoutReconciliation > 0}
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

function ProductTable({ products }: { products: InvProductRow[] }) {
  if (products.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No sales, inventory counts, or waitlist signups in this window.
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Product</th>
            <th className="text-right px-3 py-2">On hand</th>
            <th className="text-right px-3 py-2">Inv value</th>
            <th className="text-right px-3 py-2">COGS (yr)</th>
            <th className="text-right px-3 py-2">Turnover</th>
            <th className="text-right px-3 py-2">Waiting</th>
            <th className="text-right px-3 py-2">Stockout $</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr
              key={p.productId}
              className="border-t border-slate-100 hover:bg-slate-50"
            >
              <td className="px-3 py-2">
                {p.productName ?? (
                  <span className="font-mono text-xs text-slate-500">
                    {p.productId}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.onHandQty ?? <span className="text-amber-700">—</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.inventoryValueCents != null
                  ? money(p.inventoryValueCents)
                  : "—"}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(p.annualizedCogsCents)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {turns(p.turnover)}
              </td>
              <td
                className="px-3 py-2 text-right tabular-nums"
                style={{
                  color: p.waitingCount > 0 ? "#b45309" : "hsl(var(--ink-3))",
                }}
              >
                {p.waitingCount}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {p.stockoutDemandCents != null
                  ? money(p.stockoutDemandCents)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
