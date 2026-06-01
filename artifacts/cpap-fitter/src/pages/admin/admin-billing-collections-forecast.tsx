// /admin/billing/collections-forecast — AR collections projection
// (Owner #4, slice 1).
//
// Projects expected cash from outstanding (submitted/accepted) claims by
// horizon. The model's assumptions are tunable inline so the owner can
// run what-ifs; the numbers are estimates, labeled as such. Money +
// counts only — no PHI. reports.read.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getCollectionsForecast,
  getForwardOrderBook,
  type ForecastTuning,
} from "@/lib/admin/collections-forecast-api";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function AdminBillingCollectionsForecastPage() {
  const [tuning, setTuning] = useState<ForecastTuning>({});
  const query = useQuery({
    queryKey: ["admin", "collections-forecast", tuning] as const,
    queryFn: () => getCollectionsForecast(tuning),
    staleTime: 60_000,
  });

  const orderBook = useQuery({
    queryKey: ["admin", "forward-order-book"] as const,
    queryFn: getForwardOrderBook,
    staleTime: 60_000,
  });

  const maxHorizon = Math.max(
    1,
    ...(query.data?.horizons ?? []).map((h) => h.expectedCents),
  );

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-collections-forecast-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <TrendingUp className="h-6 w-6" />
          Collections forecast
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Expected cash from claims in flight (submitted / accepted, not yet
          paid), bucketed by when we expect each to land. These are estimates
          driven by the assumptions below — tune them to run a what-if.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Projecting collections…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard
              label="Total expected"
              value={money(query.data.totalExpectedCents)}
              tone="gold"
            />
            <KpiCard
              label="Claims in flight"
              value={query.data.outstandingClaimCount}
            />
          </div>

          <Card title="Expected collections by horizon">
            <div className="space-y-3">
              {query.data.horizons.map((h) => (
                <div key={h.label} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span style={{ color: "hsl(var(--ink-2))" }}>
                      {h.label}
                      <span
                        className="ml-2 text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {h.claimCount} claim{h.claimCount === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {money(h.expectedCents)}
                    </span>
                  </div>
                  <div
                    className="h-2 rounded"
                    style={{ background: "hsl(var(--line-1))" }}
                  >
                    <div
                      className="h-2 rounded"
                      style={{
                        width: `${Math.round((h.expectedCents / maxHorizon) * 100)}%`,
                        background: "var(--penn-gold, #b8860b)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <AssumptionsCard
            assumptions={query.data.assumptions}
            onChange={setTuning}
            pending={query.isFetching}
          />

          {orderBook.data && (
            <Card title="Forward resupply revenue (next 90 days)">
              <p
                className="text-xs mb-3"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Expected NEW resupply orders from patients becoming eligible
                (last fill + cadence), at{" "}
                {money(orderBook.data.assumptions.expectedOrderValueCents)} per
                order ×{" "}
                {Math.round(orderBook.data.assumptions.confirmRate * 100)}%
                confirm rate — an estimate.
              </p>
              <div className="space-y-2">
                {orderBook.data.horizons.map((h) => (
                  <div key={h.label} className="flex justify-between text-sm">
                    <span style={{ color: "hsl(var(--ink-2))" }}>
                      {h.label}
                      <span
                        className="ml-2 text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {h.dueCount} due
                      </span>
                    </span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {money(h.expectedCents)}
                    </span>
                  </div>
                ))}
                <div
                  className="flex justify-between text-sm pt-2 border-t"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <span style={{ color: "hsl(var(--ink-2))" }}>
                    Total expected
                  </span>
                  <span
                    className="font-semibold tabular-nums"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {money(orderBook.data.totalExpectedCents)}
                  </span>
                </div>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function AssumptionsCard({
  assumptions,
  onChange,
  pending,
}: {
  assumptions: {
    expectedDaysToPay: number;
    defaultAllowedRatio: number;
    collectionProbability: number;
  };
  onChange: (t: ForecastTuning) => void;
  pending: boolean;
}) {
  return (
    <Card title="Assumptions">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <NumberField
          label="Expected days to pay"
          value={assumptions.expectedDaysToPay}
          step={1}
          min={1}
          max={365}
          onCommit={(v) =>
            onChange({
              expectedDaysToPay: v,
              defaultAllowedRatio: assumptions.defaultAllowedRatio,
              collectionProbability: assumptions.collectionProbability,
            })
          }
        />
        <NumberField
          label="Allowed ÷ billed (when unknown)"
          value={assumptions.defaultAllowedRatio}
          step={0.05}
          min={0}
          max={1}
          onCommit={(v) =>
            onChange({
              expectedDaysToPay: assumptions.expectedDaysToPay,
              defaultAllowedRatio: v,
              collectionProbability: assumptions.collectionProbability,
            })
          }
        />
        <NumberField
          label="Collection probability"
          value={assumptions.collectionProbability}
          step={0.05}
          min={0}
          max={1}
          onCommit={(v) =>
            onChange({
              expectedDaysToPay: assumptions.expectedDaysToPay,
              defaultAllowedRatio: assumptions.defaultAllowedRatio,
              collectionProbability: v,
            })
          }
        />
      </div>
      <p className="text-xs mt-3" style={{ color: "hsl(var(--ink-3))" }}>
        {pending
          ? "Recomputing…"
          : "Adjust an assumption to re-run the projection."}
      </p>
    </Card>
  );
}

function NumberField({
  label,
  value,
  step,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <label className="flex flex-col gap-1">
      <span style={{ color: "hsl(var(--ink-3))" }}>{label}</span>
      <input
        type="number"
        value={draft}
        step={step}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (!Number.isNaN(n) && n >= min && n <= max) onCommit(n);
          else setDraft(String(value));
        }}
        className="rounded border px-2 py-1"
        style={{ borderColor: "hsl(var(--line-1))" }}
      />
    </label>
  );
}
