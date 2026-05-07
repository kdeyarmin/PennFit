// /admin/shop/subscriptions — operator KPI dashboard for
// subscription health. Six big-number tiles + a 6-month cohort table
// + a 30-day churn percentage. All counters come from one round-trip
// against the local shop_subscriptions mirror.

import { useQuery } from "@tanstack/react-query";
import {
  fetchSubsMetrics,
  type SubsMetrics,
} from "@/lib/admin/shop-subs-metrics-api";

export function AdminShopSubscriptionsPage() {
  const query = useQuery({
    queryKey: ["admin-shop-subs-metrics"],
    queryFn: fetchSubsMetrics,
  });

  return (
    <div className="space-y-6" data-testid="admin-shop-subs-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Subscription health
        </h1>
        <p className="text-sm text-slate-600">
          Live counters across the auto-ship subscription pipeline. Counts come
          from the local Stripe mirror so the page is fast even with thousands
          of subscribers.
        </p>
      </header>

      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load metrics:{" "}
          {query.error instanceof Error ? query.error.message : "unknown error"}
          .
        </div>
      ) : query.data ? (
        <Body data={query.data} />
      ) : null}
    </div>
  );
}

function Body({ data }: { data: SubsMetrics }) {
  const c = data.counters;
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Tile label="Active right now" value={c?.activeNow ?? 0} tone="navy" />
        <Tile label="Paused" value={c?.pausedNow ?? 0} tone="amber" />
        <Tile
          label="Past due / unpaid"
          value={c?.pastDueNow ?? 0}
          tone={c?.pastDueNow ? "rose" : "slate"}
        />
        <Tile
          label="Pending cancellations"
          value={c?.pendingCancellations ?? 0}
          tone={c?.pendingCancellations ? "amber" : "slate"}
          hint="active subs flagged cancel-at-period-end"
        />
        <Tile
          label="New (last 30 days)"
          value={c?.newSubsLast30d ?? 0}
          tone="emerald"
        />
        <Tile
          label="Canceled (last 30 days)"
          value={c?.canceledLast30d ?? 0}
          tone={c?.canceledLast30d ? "rose" : "slate"}
        />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">
              30-day churn rate
            </h2>
            <p className="text-xs text-slate-500">
              Canceled in last 30 days ÷ (active + canceled in last 30 days).
              Lower is better; healthy SaaS benchmarks sit at 1–3%.
            </p>
          </div>
          <div className="text-3xl font-bold tabular-nums text-slate-900">
            {data.churnRate30d.toFixed(1)}%
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700 mb-2">
          Cohort retention (last 6 months)
        </h2>
        <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Cohort</th>
                <th className="text-right px-3 py-2">Created</th>
                <th className="text-right px-3 py-2">Still live</th>
                <th className="text-right px-3 py-2">Retention</th>
              </tr>
            </thead>
            <tbody>
              {data.cohort.map((row) => {
                const retention =
                  row.totalCreated > 0
                    ? (row.stillLive / row.totalCreated) * 100
                    : 0;
                return (
                  <tr
                    key={row.cohortMonth}
                    className="border-t border-slate-100"
                  >
                    <td className="px-3 py-2 font-mono text-slate-700">
                      {row.cohortMonth}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.totalCreated}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.stillLive}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold">
                      {row.totalCreated > 0 ? `${retention.toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          A cohort is the set of subscriptions created in the calendar month
          shown. &ldquo;Still live&rdquo; counts subs currently in active,
          trialing, paused, or past_due — anything that hasn&apos;t been
          canceled outright.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <Tile
          label="New (last 90 days)"
          value={c?.newSubsLast90d ?? 0}
          tone="emerald"
        />
        <Tile
          label="Canceled (last 90 days)"
          value={c?.canceledLast90d ?? 0}
          tone="rose"
        />
        <Tile
          label="Lifetime cancellations"
          value={c?.canceledLifetime ?? 0}
          tone="slate"
        />
        <Tile
          label="Lifetime new"
          value={(c?.activeNow ?? 0) + (c?.canceledLifetime ?? 0)}
          tone="slate"
        />
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: "navy" | "emerald" | "amber" | "rose" | "slate";
  hint?: string;
}) {
  const toneClass: Record<typeof tone, string> = {
    navy: "border-blue-200 bg-blue-50 text-blue-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
    slate: "border-slate-200 bg-white text-slate-700",
  };
  return (
    <div className={`rounded-lg border p-4 ${toneClass[tone]}`}>
      <div className="text-xs uppercase tracking-wider opacity-80">{label}</div>
      <div className="text-3xl font-bold tabular-nums mt-1">{value}</div>
      {hint && <div className="text-[11px] mt-1 opacity-70">{hint}</div>}
    </div>
  );
}
