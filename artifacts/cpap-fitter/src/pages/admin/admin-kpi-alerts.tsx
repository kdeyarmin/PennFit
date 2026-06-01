// /admin/kpi-alerts — owner KPI alerting (Owner #5). Two panels:
//   1. Open alerts — the F2 evaluator's feed; acknowledge / resolve.
//   2. Alert rules — CRUD over metric_thresholds the evaluator walks.
//
// metrics.read-gated (read); rule mutations are admin.tools.manage on the
// server. Not PHI — headline KPI alerts + rule config only.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Trash2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Badge } from "@/components/admin/Badge";
import {
  listMetricAlerts,
  updateMetricAlert,
  listMetricThresholds,
  createMetricThreshold,
  patchMetricThreshold,
  deleteMetricThreshold,
  type AlertStatusFilter,
  type Comparison,
  type MetricAlert,
  type MetricThreshold,
  type Severity,
  type ThresholdMode,
} from "@/lib/admin/kpi-alerts-api";

const METRIC_KEYS = [
  "revenue_net_cents",
  "revenue_gross_cents",
  "revenue_refunded_cents",
  "orders_paid_count",
];

const COMPARISON_LABEL: Record<Comparison, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};
const MODE_LABEL: Record<ThresholdMode, string> = {
  absolute: "value",
  delta_7d: "7-day Δ",
  delta_pct_7d: "7-day %Δ",
};
const SEVERITY_VARIANT: Record<Severity, "info" | "warning" | "danger"> = {
  info: "info",
  warning: "warning",
  critical: "danger",
};

const ALERTS_KEY = ["admin", "metric-alerts"] as const;
const THRESHOLDS_KEY = ["admin", "metric-thresholds"] as const;

export function AdminKpiAlertsPage() {
  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-kpi-alerts-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BellRing className="h-6 w-6" />
          KPI alerts
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          The nightly evaluator checks each enabled rule against the daily KPI
          snapshot and raises an alert on a breach. Triage the feed and tune the
          rules here.
        </p>
      </header>

      <AlertsPanel />
      <RulesPanel />
    </div>
  );
}

function AlertsPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<AlertStatusFilter>("open");
  const query = useQuery({
    queryKey: [...ALERTS_KEY, filter] as const,
    queryFn: () => listMetricAlerts(filter),
    refetchInterval: 120_000,
  });

  const update = useMutation({
    mutationFn: (v: { id: string; status: "acknowledged" | "resolved" }) =>
      updateMetricAlert(v.id, v.status),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ALERTS_KEY }),
  });

  return (
    <Card title="Open alerts">
      <div
        role="tablist"
        aria-label="Filter alerts by status"
        className="inline-flex gap-1 p-1 rounded-lg bg-slate-100 mb-3"
      >
        {(
          ["open", "acknowledged", "resolved", "all"] as AlertStatusFilter[]
        ).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === filter}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 text-xs rounded-md font-medium capitalize transition-colors ${
              s === filter
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading alerts…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.alerts.length === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No {filter === "all" ? "" : `${filter} `}alerts.
        </p>
      ) : (
        <ul className="space-y-2">
          {query.data.alerts.map((a) => (
            <AlertRow
              key={a.id}
              alert={a}
              onAck={() => update.mutate({ id: a.id, status: "acknowledged" })}
              onResolve={() => update.mutate({ id: a.id, status: "resolved" })}
              busy={update.isPending}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AlertRow({
  alert,
  onAck,
  onResolve,
  busy,
}: {
  alert: MetricAlert;
  onAck: () => void;
  onResolve: () => void;
  busy: boolean;
}) {
  return (
    <li className="rounded border border-slate-200 p-3 flex items-start justify-between gap-3 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[alert.severity]}>
            {alert.severity}
          </Badge>
          <span className="font-mono text-xs text-slate-500">
            {alert.metricKey} · {alert.metricDate}
          </span>
        </div>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-1))" }}>
          {alert.message}
        </p>
      </div>
      {alert.status !== "resolved" && (
        <div className="flex items-center gap-2">
          {alert.status === "open" && (
            <Button intent="ghost" size="sm" onClick={onAck} disabled={busy}>
              Acknowledge
            </Button>
          )}
          <Button
            intent="secondary"
            size="sm"
            onClick={onResolve}
            disabled={busy}
          >
            Resolve
          </Button>
        </div>
      )}
      {alert.status === "resolved" && (
        <span className="text-xs text-slate-400">resolved</span>
      )}
    </li>
  );
}

function RulesPanel() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: THRESHOLDS_KEY,
    queryFn: listMetricThresholds,
    staleTime: 60_000,
  });

  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      patchMetricThreshold(v.id, { enabled: v.enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: THRESHOLDS_KEY }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteMetricThreshold(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: THRESHOLDS_KEY }),
  });

  return (
    <Card title="Alert rules">
      <NewRuleForm
        onCreated={() =>
          void qc.invalidateQueries({ queryKey: THRESHOLDS_KEY })
        }
      />

      {query.isPending ? (
        <Spinner label="Loading rules…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.thresholds.length === 0 ? (
        <p className="text-sm mt-3" style={{ color: "hsl(var(--ink-3))" }}>
          No rules yet. Add one above — e.g. net revenue &lt; floor, or denial
          rate 7-day %Δ &gt; 5.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {query.data.thresholds.map((t) => (
            <RuleRow
              key={t.id}
              rule={t}
              onToggle={() => toggle.mutate({ id: t.id, enabled: !t.enabled })}
              onDelete={() => remove.mutate(t.id)}
              busy={toggle.isPending || remove.isPending}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RuleRow({
  rule,
  onToggle,
  onDelete,
  busy,
}: {
  rule: MetricThreshold;
  onToggle: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="py-2 flex items-center justify-between gap-3 text-sm">
      <div className="min-w-0">
        <span
          className="font-mono text-xs"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {rule.metricKey} {COMPARISON_LABEL[rule.comparison]}{" "}
          {rule.thresholdValue.toLocaleString()}
        </span>
        <span className="ml-2 text-[11px] text-slate-500">
          {MODE_LABEL[rule.mode]} · {rule.severity}
        </span>
        {rule.description && (
          <p className="text-[11px] text-slate-500 mt-0.5">
            {rule.description}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={onToggle}
            disabled={busy}
            aria-label={`Enable ${rule.metricKey} rule`}
          />
          enabled
        </label>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-rose-600 hover:text-rose-800 disabled:opacity-50"
          aria-label="Delete rule"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const [metricKey, setMetricKey] = useState(METRIC_KEYS[0]!);
  const [comparison, setComparison] = useState<Comparison>("lt");
  const [mode, setMode] = useState<ThresholdMode>("absolute");
  const [severity, setSeverity] = useState<Severity>("warning");
  const [value, setValue] = useState("");

  const valueNum = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(valueNum);

  const create = useMutation({
    mutationFn: () =>
      createMetricThreshold({
        metricKey,
        comparison,
        thresholdValue: valueNum,
        mode,
        severity,
      }),
    onSuccess: () => {
      setValue("");
      onCreated();
    },
  });

  const selectCls = "rounded border border-slate-300 px-2 py-1.5 text-sm";

  return (
    <div className="flex flex-wrap items-end gap-2">
      <select
        value={metricKey}
        onChange={(e) => setMetricKey(e.target.value)}
        className={selectCls}
        aria-label="Rule metric"
      >
        {METRIC_KEYS.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <select
        value={comparison}
        onChange={(e) => setComparison(e.target.value as Comparison)}
        className={selectCls}
        aria-label="Rule comparison"
      >
        {(["lt", "lte", "gt", "gte"] as Comparison[]).map((c) => (
          <option key={c} value={c}>
            {COMPARISON_LABEL[c]}
          </option>
        ))}
      </select>
      <Input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="value"
        aria-label="Threshold value"
        className="w-[120px]"
      />
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as ThresholdMode)}
        className={selectCls}
        aria-label="Rule mode"
      >
        {(["absolute", "delta_7d", "delta_pct_7d"] as ThresholdMode[]).map(
          (m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]}
            </option>
          ),
        )}
      </select>
      <select
        value={severity}
        onChange={(e) => setSeverity(e.target.value as Severity)}
        className={selectCls}
        aria-label="Rule severity"
      >
        {(["info", "warning", "critical"] as Severity[]).map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <Button
        disabled={!valid || create.isPending}
        isLoading={create.isPending}
        onClick={() => create.mutate()}
      >
        Add rule
      </Button>
      {create.error instanceof Error && (
        <span className="text-[11px] text-rose-700 w-full">
          {create.error.message}
        </span>
      )}
    </div>
  );
}
