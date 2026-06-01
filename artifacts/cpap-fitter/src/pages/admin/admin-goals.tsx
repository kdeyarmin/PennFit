// /admin/goals — owner goal / target tracking with pace-to-goal
// (Owner #8). Set a target for a headline KPI per period; the page shows
// where the F2 metrics_daily actuals put you against the linear track to
// hit it (ahead / on track / behind), the projected run-rate landing,
// and attainment so far.
//
// targets.manage-gated server-side (owner/admin tier); the nav entry is
// gated to match. Not PHI — headline business KPIs only.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Target } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Badge } from "@/components/admin/Badge";
import {
  listBusinessTargets,
  upsertBusinessTarget,
  type BusinessTarget,
  type GoalPaceStatus,
  type MetricUnit,
} from "@/lib/admin/business-targets-api";

const METRICS: ReadonlyArray<{
  key: string;
  label: string;
  unit: MetricUnit;
}> = [
  { key: "revenue_net_cents", label: "Net revenue", unit: "cents" },
  { key: "revenue_gross_cents", label: "Gross revenue", unit: "cents" },
  { key: "orders_paid_count", label: "Paid orders", unit: "count" },
  { key: "revenue_refunded_cents", label: "Refunds", unit: "cents" },
];

const STATUS: Record<
  GoalPaceStatus,
  { variant: "success" | "info" | "danger" | "muted"; label: string }
> = {
  ahead: { variant: "success", label: "Ahead" },
  on_track: { variant: "info", label: "On track" },
  behind: { variant: "danger", label: "Behind" },
  unknown: { variant: "muted", label: "No data yet" },
};

function metricLabel(key: string): string {
  return METRICS.find((m) => m.key === key)?.label ?? key;
}

function fmtValue(value: number | null, unit: MetricUnit): string {
  if (value == null) return "—";
  if (unit === "cents")
    return (value / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  if (unit === "count") return Math.round(value).toLocaleString();
  return value.toLocaleString();
}

function currentMonthPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function AdminGoalsPage() {
  const query = useQuery({
    queryKey: ["admin", "business-targets"],
    queryFn: () => listBusinessTargets(),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-goals-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Target className="h-6 w-6" />
          Goals &amp; targets
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Set a target for a headline KPI per period and watch pace-to-goal:
          where you are against the linear track, and where the current run-rate
          projects you to land.
        </p>
      </header>

      <SetTargetCard />

      {query.isPending ? (
        <Spinner label="Loading targets…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.targets.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No targets set yet. Add one above.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {query.data.targets.map((t) => (
            <TargetCard key={t.id} target={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function SetTargetCard() {
  const qc = useQueryClient();
  const [metricKey, setMetricKey] = useState(METRICS[0]!.key);
  const [period, setPeriod] = useState(currentMonthPeriod());
  const [amount, setAmount] = useState("");

  const unit = METRICS.find((m) => m.key === metricKey)?.unit ?? "count";
  const amountNum = Number(amount);
  const valid =
    /^\d{4}(-\d{2})?$/.test(period.trim()) &&
    Number.isFinite(amountNum) &&
    amountNum >= 0 &&
    amount.trim() !== "";

  const save = useMutation({
    mutationFn: () =>
      upsertBusinessTarget({
        metricKey,
        period: period.trim(),
        // Cents metrics are entered in dollars for sanity; store as cents.
        targetValue: unit === "cents" ? Math.round(amountNum * 100) : amountNum,
        unit,
      }),
    onSuccess: () => {
      setAmount("");
      void qc.invalidateQueries({ queryKey: ["admin", "business-targets"] });
    },
  });

  return (
    <Card title="Set a target">
      <div className="flex flex-wrap gap-3 items-end">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Metric
          </span>
          <select
            value={metricKey}
            onChange={(e) => setMetricKey(e.target.value)}
            className="rounded border border-slate-300 px-2 py-2 text-sm min-w-[180px]"
            aria-label="Target metric"
          >
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Period
          </span>
          <Input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-05"
            aria-label="Target period"
            className="w-[120px]"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Target {unit === "cents" ? "($)" : ""}
          </span>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={unit === "cents" ? "50000" : "200"}
            aria-label="Target value"
            className="w-[140px]"
          />
        </label>
        <Button
          disabled={!valid || save.isPending}
          isLoading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save target
        </Button>
      </div>
      {!valid &&
        period.trim() !== "" &&
        !/^\d{4}(-\d{2})?$/.test(period.trim()) && (
          <p className="mt-2 text-xs" style={{ color: "#b45309" }}>
            Period must be a month (2026-05) or year (2026).
          </p>
        )}
      {save.error instanceof Error && (
        <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {save.error.message}
        </p>
      )}
    </Card>
  );
}

function TargetCard({ target }: { target: BusinessTarget }) {
  const unit = target.unit;
  const pace = target.pace;
  const status = STATUS[pace?.status ?? "unknown"];
  const attainment = pace?.attainmentRatio ?? null;
  const barPct =
    attainment == null ? 0 : Math.max(0, Math.min(1, attainment)) * 100;
  const barColor =
    status.variant === "success"
      ? "#15803d"
      : status.variant === "danger"
        ? "#b91c1c"
        : status.variant === "info"
          ? "hsl(var(--penn-navy))"
          : "#94a3b8";

  return (
    <Card>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {metricLabel(target.metricKey)}{" "}
            <span className="text-xs font-normal text-slate-500">
              · {target.period}
            </span>
          </p>
          <p className="text-xs mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
            Target {fmtValue(target.targetValue, unit)}
            {pace && pace.status !== "unknown" && (
              <>
                {" · "}projected {fmtValue(pace.projectedValue, unit)} at this
                run-rate
              </>
            )}
          </p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </div>

      <div className="mt-3">
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${barPct}%`, backgroundColor: barColor }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
          <span>
            {fmtValue(pace?.actualToDate ?? null, unit)} so far
            {attainment != null &&
              ` · ${Math.round(attainment * 100)}% of goal`}
          </span>
          {pace && pace.status !== "unknown" && (
            <span>
              day {pace.daysElapsed}/{pace.daysInPeriod}
              {pace.paceRatio != null &&
                ` · ${Math.round(pace.paceRatio * 100)}% of pace`}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
