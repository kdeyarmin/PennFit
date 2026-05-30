// /admin/billing/aging — open-A/R aging report.
//
// Pulls /admin/billing/aging-report (every non-terminal claim summed
// into 0-30 / 31-60 / 61-90 / 90+ day buckets) plus the same data
// broken out by payer. Highlights the 90+ column because that's the
// money most likely to write off.
//
// Read-only — no per-row actions, since aging the individual claim
// happens inside the patient claim drawer.

import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchAgingReport,
  formatMoneyCents,
  type AgingBucketKey,
  type AgingBuckets,
} from "@/lib/admin/billing-api";

const BUCKETS: ReadonlyArray<{ key: AgingBucketKey; label: string }> = [
  { key: "0_30", label: "0 – 30" },
  { key: "31_60", label: "31 – 60" },
  { key: "61_90", label: "61 – 90" },
  { key: "90_plus", label: "90+" },
];

function bucketTotal(b: AgingBuckets): number {
  return BUCKETS.reduce((s, { key }) => s + b[key].billedCents, 0);
}

function bucketClaims(b: AgingBuckets): number {
  return BUCKETS.reduce((s, { key }) => s + b[key].claimCount, 0);
}

export function AdminBillingAgingPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-billing-aging"],
    queryFn: fetchAgingReport,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-aging"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          A/R aging
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Open claims (anything not paid or closed) by days since the earlier of
          submitted-at or DOS. The 90+ bucket is where collections work pays
          best.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      {isPending ? (
        <Spinner label="Loading aging…" />
      ) : (
        <>
          <Card
            title="Open A/R — overall"
            subtitle={`${data?.totalOpenClaimCount ?? 0} open claim(s) totalling ${formatMoneyCents(data?.totalOpenBilledCents ?? 0)}`}
          >
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="py-2">Age (days)</th>
                  <th className="py-2 text-right">Claim count</th>
                  <th className="py-2 text-right">Billed</th>
                </tr>
              </thead>
              <tbody>
                {data &&
                  BUCKETS.map(({ key, label }) => (
                    <tr
                      key={key}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td
                        className="py-2 font-medium"
                        style={{
                          color:
                            key === "90_plus" ? "#b91c1c" : "hsl(var(--ink-1))",
                        }}
                      >
                        {label}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {data.overall[key].claimCount}
                      </td>
                      <td
                        className="py-2 text-right tabular-nums font-semibold"
                        style={{
                          color:
                            key === "90_plus" ? "#b91c1c" : "hsl(var(--ink-1))",
                        }}
                      >
                        {formatMoneyCents(data.overall[key].billedCents)}
                      </td>
                    </tr>
                  ))}
                {data && (
                  <tr
                    className="border-t-2"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="py-2 font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      Total
                    </td>
                    <td className="py-2 text-right tabular-nums font-semibold">
                      {data.totalOpenClaimCount}
                    </td>
                    <td className="py-2 text-right tabular-nums font-semibold">
                      {formatMoneyCents(data.totalOpenBilledCents)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>

          <Card
            title="A/R aging by payer"
            subtitle="Sorted by total open dollars across all age buckets"
          >
            {(data?.perPayer.length ?? 0) === 0 ? (
              <p
                className="text-sm py-1"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                No open A/R right now.
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
                      {BUCKETS.map((b) => (
                        <th key={b.key} className="p-3 text-right">
                          {b.label}
                        </th>
                      ))}
                      <th className="p-3 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.perPayer ?? []).map((row) => (
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
                        {BUCKETS.map((b) => (
                          <td
                            key={b.key}
                            className="p-3 text-right tabular-nums"
                            style={{
                              color:
                                b.key === "90_plus" &&
                                row.buckets[b.key].billedCents > 0
                                  ? "#b91c1c"
                                  : "hsl(var(--ink-1))",
                            }}
                          >
                            {row.buckets[b.key].billedCents === 0
                              ? "—"
                              : formatMoneyCents(
                                  row.buckets[b.key].billedCents,
                                )}
                            {row.buckets[b.key].claimCount > 0 && (
                              <span
                                className="block text-[10px]"
                                style={{ color: "hsl(var(--ink-3))" }}
                              >
                                {row.buckets[b.key].claimCount} cl.
                              </span>
                            )}
                          </td>
                        ))}
                        <td className="p-3 text-right tabular-nums font-semibold">
                          {formatMoneyCents(bucketTotal(row.buckets))}
                          <span
                            className="block text-[10px]"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {bucketClaims(row.buckets)} cl.
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
