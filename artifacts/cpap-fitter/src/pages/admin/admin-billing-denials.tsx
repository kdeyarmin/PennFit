// /admin/billing/denials — denial rate dashboard.
//
// Overall denial-rate headline + a per-payer table. The overall
// number is the "is our scrub stack working" question; the per-payer
// table is where you find the payer who suddenly started denying
// everything (often a policy update we haven't caught up to).
//
// We surface DSO-by-payer on the same page since the same audience
// reads them together: a 95% paid + 90-day DSO payer is materially
// different from a 95% paid + 20-day DSO payer.

import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchDenialRate,
  fetchDsoByPayer,
  formatMoneyCents,
  formatPercent,
} from "@/lib/admin/billing-api";

export function AdminBillingDenialsPage() {
  const denials = useQuery({
    queryKey: ["admin-billing-denial-rate"],
    queryFn: fetchDenialRate,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const dso = useQuery({
    queryKey: ["admin-billing-dso"],
    queryFn: fetchDsoByPayer,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-denials"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Denials & DSO
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          90-day denial-rate window plus 180-day average days-to-pay,
          broken out by payer. Spike in one payer + steady overall =
          payer policy change. Steady per-payer + rising overall =
          mix shift.
        </p>
      </header>

      {denials.isError && (
        <ErrorPanel
          error={denials.error}
          onRetry={() => void denials.refetch()}
        />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryTile
          label="Overall denial rate"
          value={
            denials.isPending
              ? "—"
              : formatPercent(denials.data?.overall.denialRate ?? null)
          }
          hint="Last 90 days, decisions only"
          isLoading={denials.isPending}
        />
        <SummaryTile
          label="Decisions reached"
          value={
            denials.isPending
              ? "—"
              : (denials.data?.overall.decisions ?? 0).toLocaleString()
          }
          hint="Paid + denied + appealed + closed"
          isLoading={denials.isPending}
        />
        <SummaryTile
          label="Total denied"
          value={
            denials.isPending
              ? "—"
              : (denials.data?.overall.denials ?? 0).toLocaleString()
          }
          hint="Where to focus appeal effort"
          isLoading={denials.isPending}
        />
      </div>

      <Card
        title="Denial rate by payer"
        subtitle="Sorted by absolute denials (where the dollars are)"
      >
        {denials.isPending ? (
          <Spinner label="Loading denial rate…" />
        ) : (denials.data?.perPayer.length ?? 0) === 0 ? (
          <p
            className="text-sm py-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            No decisions in the last 90 days.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Payer</th>
                  <th className="p-3 text-right">Decisions</th>
                  <th className="p-3 text-right">Denials</th>
                  <th className="p-3 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {(denials.data?.perPayer ?? []).map((row) => {
                  const tone =
                    (row.denialRate ?? 0) >= 0.2
                      ? "#b91c1c"
                      : (row.denialRate ?? 0) >= 0.1
                        ? "#b45309"
                        : "hsl(var(--ink-1))";
                  return (
                    <tr
                      key={row.payerName}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td
                        className="p-3 font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {row.payerName || "—"}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.decisions}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.denials}
                      </td>
                      <td
                        className="p-3 text-right tabular-nums font-semibold"
                        style={{ color: tone }}
                      >
                        {formatPercent(row.denialRate)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {dso.isError && (
        <ErrorPanel error={dso.error} onRetry={() => void dso.refetch()} />
      )}

      <Card
        title="Days-to-pay by payer"
        subtitle="180-day window. Paid claims only — submitted-at → paid-at."
      >
        {dso.isPending ? (
          <Spinner label="Loading DSO…" />
        ) : (dso.data?.payers.length ?? 0) === 0 ? (
          <p
            className="text-sm py-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            No paid claims in the last 180 days.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Payer</th>
                  <th className="p-3 text-right">Paid claims</th>
                  <th className="p-3 text-right">Total paid</th>
                  <th className="p-3 text-right">Avg days</th>
                </tr>
              </thead>
              <tbody>
                {(dso.data?.payers ?? []).map((row) => {
                  const tone =
                    (row.averageDaysToPay ?? 0) >= 45
                      ? "#b91c1c"
                      : (row.averageDaysToPay ?? 0) >= 30
                        ? "#b45309"
                        : "hsl(var(--ink-1))";
                  return (
                    <tr
                      key={row.payerName}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td
                        className="p-3 font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {row.payerName || "—"}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {row.claimCount}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {formatMoneyCents(row.totalPaidCents)}
                      </td>
                      <td
                        className="p-3 text-right tabular-nums font-semibold"
                        style={{ color: tone }}
                      >
                        {row.averageDaysToPay == null
                          ? "—"
                          : row.averageDaysToPay.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  hint,
  isLoading,
}: {
  label: string;
  value: string;
  hint: string;
  isLoading: boolean;
}) {
  return (
    <div className="surface-card p-5">
      <p
        className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-2"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </p>
      <p
        className="text-3xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {isLoading ? (
          <span className="skeleton inline-block h-7 w-16 align-middle" />
        ) : (
          value
        )}
      </p>
      <p
        className="text-xs mt-2 leading-snug"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {hint}
      </p>
    </div>
  );
}
