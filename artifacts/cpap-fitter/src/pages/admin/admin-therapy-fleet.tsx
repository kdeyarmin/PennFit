// /admin/therapy-fleet — population-level therapy-cloud analytics.
//
// Where /admin/integrations answers "are the vendor adapters healthy?",
// this page answers "how is my whole CPAP base doing, and who do I call
// today?" using the same nightly telemetry the adapters pull from ResMed
// AirView / Philips Care Orchestrator / React Health / Health Connect.
//
//   * KPI tiles — patients with data, CMS-compliance cohorts, clinical
//     flags (high AHI / high leak / low usage), population averages.
//   * Outreach worklist — patients needing a call, each tagged with the
//     reason(s) and a weighted priority. Filterable by reason and
//     exportable to CSV for a calling list.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  BellOff,
  CalendarClock,
  Check,
  Download,
  HeartPulse,
  PackageCheck,
  PhoneCall,
  Stethoscope,
  Wind,
} from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getFleetOverview,
  getFleetTrend,
  getFleetWorklist,
  fleetWorklistCsvUrl,
  setWorklistAction,
  type FleetTrendPoint,
  type WorklistAction,
  type WorklistActionStatus,
  type WorklistEntry,
  type WorklistReason,
} from "@/lib/admin/therapy-fleet-api";

const WINDOW_OPTIONS = [7, 30, 60, 90] as const;

// Reason metadata: label + badge tone + the DME "so what". Kept in
// lockstep with the worklist RPC (migration 0179).
const REASON_META: Record<
  WorklistReason,
  {
    label: string;
    variant: "danger" | "warning" | "info" | "neutral";
    blurb: string;
  }
> = {
  compliance_risk: {
    label: "Compliance risk",
    variant: "danger",
    blurb: "Below 21 nights ≥4h this window — Medicare reimbursement at risk",
  },
  no_recent_data: {
    label: "Device silent",
    variant: "warning",
    blurb: "No nights reported in 7+ days — modem or adherence issue",
  },
  high_ahi: {
    label: "High AHI",
    variant: "danger",
    blurb: "Residual AHI ≥5 — therapy may be ineffective; clinical follow-up",
  },
  high_leak: {
    label: "High leak",
    variant: "warning",
    blurb: "Leak ≥24 L/min — re-fit / mask resupply opportunity",
  },
  usage_decline: {
    label: "Usage decline",
    variant: "info",
    blurb: "Usage down >25% vs prior window — early churn signal",
  },
};

const ALL_REASONS = Object.keys(REASON_META) as WorklistReason[];

function minutesToHours(min: number | null): string {
  if (min === null) return "—";
  return `${(min / 60).toFixed(1)}h`;
}

function fmt(n: number | null, digits = 1): string {
  if (n === null) return "—";
  return n.toFixed(digits);
}

export function AdminTherapyFleetPage() {
  const qc = useQueryClient();
  const [windowDays, setWindowDays] = useState<number>(30);
  const [reason, setReason] = useState<WorklistReason | null>(null);
  const [includeHandled, setIncludeHandled] = useState(false);

  const overviewQ = useQuery({
    queryKey: ["admin", "therapy-fleet", "overview", windowDays],
    queryFn: () => getFleetOverview(windowDays),
    refetchOnWindowFocus: false,
  });
  const worklistQ = useQuery({
    queryKey: [
      "admin",
      "therapy-fleet",
      "worklist",
      windowDays,
      reason,
      includeHandled,
    ],
    queryFn: () =>
      getFleetWorklist({
        windowDays,
        limit: 200,
        reason: reason ?? undefined,
        includeHandled,
      }),
    refetchOnWindowFocus: false,
  });

  const trendQ = useQuery({
    queryKey: ["admin", "therapy-fleet", "trend"],
    queryFn: () => getFleetTrend(90),
    refetchOnWindowFocus: false,
  });

  const actionMutation = useMutation({
    mutationFn: (vars: {
      patientId: string;
      action: WorklistActionStatus;
      snoozeUntil?: string;
    }) =>
      setWorklistAction(vars.patientId, {
        action: vars.action,
        snoozeUntil: vars.snoozeUntil,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["admin", "therapy-fleet", "worklist"],
      });
    },
  });

  const ov = overviewQ.data?.overview;
  const withData = ov?.patientsWithData ?? 0;
  const complianceRate =
    withData > 0 && ov
      ? Math.round((ov.cohorts.compliant / withData) * 100)
      : 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <HeartPulse className="h-6 w-6" /> Therapy fleet
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Population compliance + clinical worklist across ResMed AirView,
            Philips Care Orchestrator, React Health, and Health Connect — over
            the last {windowDays} nights.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            <Link
              href="/admin/therapy-resupply"
              className="inline-flex items-center gap-1.5 text-sm hover:underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              <PackageCheck className="h-4 w-4" /> Resupply opportunities
            </Link>
            <Link
              href="/admin/therapy-compliance"
              className="inline-flex items-center gap-1.5 text-sm hover:underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              <CalendarClock className="h-4 w-4" /> 90-day setup adherence
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Window
          </label>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{
              borderColor: "hsl(var(--line-1))",
              backgroundColor: "hsl(var(--surface-1))",
            }}
          >
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
          <a
            href={fleetWorklistCsvUrl({
              windowDays,
              limit: 200,
              reason: reason ?? undefined,
            })}
            download
          >
            <Button intent="secondary" size="sm">
              <Download className="h-4 w-4" /> Export worklist
            </Button>
          </a>
        </div>
      </header>

      {/* ── KPI tiles ─────────────────────────────────────────────── */}
      {overviewQ.isError ? (
        <ErrorPanel
          error={overviewQ.error}
          onRetry={() => void overviewQ.refetch()}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <KpiCard
              label="Patients w/ data"
              value={withData}
              isLoading={overviewQ.isPending}
              hint={`${ov?.totalNights ?? 0} nights in window`}
            />
            <KpiCard
              label="CMS compliant"
              value={overviewQ.isPending ? "—" : `${complianceRate}%`}
              tone="gold"
              isLoading={overviewQ.isPending}
              hint={`${ov?.cohorts.compliant ?? 0} of ${withData} ≥21 nights ≥4h`}
            />
            <KpiCard
              label="At risk"
              value={ov?.cohorts.atRisk ?? 0}
              isLoading={overviewQ.isPending}
              hint="10–20 qualifying nights — recoverable"
            />
            <KpiCard
              label="Non-compliant"
              value={ov?.cohorts.nonCompliant ?? 0}
              isLoading={overviewQ.isPending}
              hint="<10 qualifying nights"
            />
          </div>

          <Card title="Population snapshot">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 text-sm">
              <Stat
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Device silent"
                value={ov?.cohorts.noRecentData ?? 0}
                loading={overviewQ.isPending}
              />
              <Stat
                icon={<Stethoscope className="h-4 w-4" />}
                label="High AHI"
                value={ov?.clinicalFlags.highAhi ?? 0}
                loading={overviewQ.isPending}
              />
              <Stat
                icon={<Wind className="h-4 w-4" />}
                label="High leak"
                value={ov?.clinicalFlags.highLeak ?? 0}
                loading={overviewQ.isPending}
              />
              <Stat
                icon={<Activity className="h-4 w-4" />}
                label="Low usage"
                value={ov?.clinicalFlags.lowUsage ?? 0}
                loading={overviewQ.isPending}
              />
              <Stat
                label="Avg usage"
                value={minutesToHours(ov?.averages.usageMinutes ?? null)}
                loading={overviewQ.isPending}
              />
              <Stat
                label="Avg AHI"
                value={fmt(ov?.averages.ahi ?? null, 2)}
                loading={overviewQ.isPending}
              />
            </div>
          </Card>
        </>
      )}

      {/* ── Trend over time ───────────────────────────────────────── */}
      {trendQ.data && trendQ.data.points.length >= 2 && (
        <Card
          title="Fleet trend"
          subtitle="Daily snapshot — is the work moving the numbers?"
        >
          <div className="grid gap-6 sm:grid-cols-3">
            <TrendStat
              label="Compliance rate"
              points={trendQ.data.points}
              value={(p) =>
                p.patientsWithData > 0
                  ? (p.compliant / p.patientsWithData) * 100
                  : null
              }
              fmt={(v) => `${Math.round(v)}%`}
              color="hsl(152 60% 38%)"
              higherIsBetter
            />
            <TrendStat
              label="At risk"
              points={trendQ.data.points}
              value={(p) => p.atRisk}
              fmt={(v) => String(Math.round(v))}
              color="hsl(354 75% 50%)"
            />
            <TrendStat
              label="Setups at risk"
              points={trendQ.data.points}
              value={(p) => p.setupsAtRisk}
              fmt={(v) => String(Math.round(v))}
              color="hsl(38 95% 45%)"
            />
          </div>
        </Card>
      )}

      {/* ── Worklist ──────────────────────────────────────────────── */}
      <Card
        title="Outreach worklist"
        subtitle="Highest-priority patients first. Filter by reason to build a focused calling list."
      >
        <div className="flex flex-wrap gap-2 mb-4">
          <ReasonChip
            active={reason === null}
            onClick={() => setReason(null)}
            label="All"
          />
          {ALL_REASONS.map((r) => (
            <ReasonChip
              key={r}
              active={reason === r}
              onClick={() => setReason(r)}
              label={REASON_META[r].label}
              title={REASON_META[r].blurb}
            />
          ))}
          <label
            className="ml-auto inline-flex items-center gap-1.5 text-xs cursor-pointer"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <input
              type="checkbox"
              checked={includeHandled}
              onChange={(e) => setIncludeHandled(e.target.checked)}
            />
            Show handled (snoozed / resolved)
          </label>
        </div>

        {worklistQ.isPending ? (
          <Spinner />
        ) : worklistQ.isError ? (
          <ErrorPanel
            error={worklistQ.error}
            onRetry={() => void worklistQ.refetch()}
          />
        ) : worklistQ.data.entries.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No patients match this filter — the fleet is in good shape. 🎉
          </p>
        ) : (
          <WorklistTable
            entries={worklistQ.data.entries}
            onAction={(patientId, action, snoozeUntil) =>
              actionMutation.mutate({ patientId, action, snoozeUntil })
            }
            pendingPatientId={
              actionMutation.isPending
                ? actionMutation.variables?.patientId
                : undefined
            }
          />
        )}
      </Card>
    </div>
  );
}

// One metric's trend: latest value, delta vs the first point in the
// window, and a sparkline. Dependency-free SVG, same approach as the
// Device Data tab.
function TrendStat({
  label,
  points,
  value,
  fmt,
  color,
  higherIsBetter,
}: {
  label: string;
  points: FleetTrendPoint[];
  value: (p: FleetTrendPoint) => number | null;
  fmt: (v: number) => string;
  color: string;
  higherIsBetter?: boolean;
}) {
  const series = points.map(value);
  const present = series.filter((v): v is number => v !== null);
  const latest = [...series].reverse().find((v): v is number => v !== null);
  const first = present[0];
  const delta =
    latest !== undefined && first !== undefined ? latest - first : null;
  const deltaGood =
    delta === null || delta === 0
      ? null
      : higherIsBetter
        ? delta > 0
        : delta < 0;
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {label}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {latest !== undefined ? fmt(latest) : "—"}
        </span>
      </div>
      <TrendSparkline values={series} color={color} />
      {delta !== null && delta !== 0 && (
        <p
          className="text-[10px] mt-0.5"
          style={{
            color:
              deltaGood === null
                ? "hsl(var(--ink-3))"
                : deltaGood
                  ? "hsl(152 70% 30%)"
                  : "hsl(354 75% 42%)",
          }}
        >
          {delta > 0 ? "▲" : "▼"} {fmt(Math.abs(delta))} over {present.length}{" "}
          days
        </p>
      )}
    </div>
  );
}

function TrendSparkline({
  values,
  color,
  height = 36,
}: {
  values: Array<number | null>;
  color: string;
  height?: number;
}) {
  const width = 200;
  const pad = 2;
  const pts = values
    .map((v, i) => ({ i, v }))
    .filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length < 2) {
    return (
      <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        Not enough data yet.
      </p>
    );
  }
  const span = values.length - 1 || 1;
  const vals = pts.map((p) => p.v);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) hi = lo + 1;
  const x = (i: number) => pad + (i / span) * (width - 2 * pad);
  const y = (v: number) =>
    height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);
  const d = pts
    .map(
      (p, k) =>
        `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`,
    )
    .join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg
      className="w-full"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${color} trend`}
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} fill={color} />
    </svg>
  );
}

function Stat({
  icon,
  label,
  value,
  loading,
}: {
  icon?: React.ReactNode;
  label: string;
  value: number | string;
  loading?: boolean;
}) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-wider font-semibold flex items-center gap-1 mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {icon}
        {label}
      </p>
      <p
        className="text-xl font-semibold tabular-nums"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {loading ? "—" : value}
      </p>
    </div>
  );
}

function ReasonChip({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
      style={{
        backgroundColor: active
          ? "hsl(var(--penn-navy))"
          : "hsl(var(--surface-1))",
        color: active ? "white" : "hsl(var(--ink-2))",
        borderColor: active ? "hsl(var(--penn-navy))" : "hsl(var(--line-1))",
      }}
    >
      {label}
    </button>
  );
}

function WorklistTable({
  entries,
  onAction,
  pendingPatientId,
}: {
  entries: WorklistEntry[];
  onAction: (
    patientId: string,
    action: WorklistActionStatus,
    snoozeUntil?: string,
  ) => void;
  pendingPatientId?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th className="py-2 font-semibold">Patient</th>
            <th className="py-2 font-semibold">Priority</th>
            <th className="py-2 font-semibold">Reasons</th>
            <th className="py-2 font-semibold text-right">Nights ≥4h</th>
            <th className="py-2 font-semibold text-right">Avg usage</th>
            <th className="py-2 font-semibold text-right">Avg AHI</th>
            <th className="py-2 font-semibold text-right">Avg leak</th>
            <th className="py-2 font-semibold text-right">Last night</th>
            <th className="py-2 font-semibold text-right">Triage</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr
              key={e.patientId}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2">
                <Link
                  href={`/admin/patients/${e.patientId}`}
                  className="font-medium hover:underline"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  {e.patientName || e.patientId.slice(0, 8)}
                </Link>
              </td>
              <td className="py-2">
                <span
                  className="inline-flex items-center justify-center min-w-[2rem] px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums"
                  style={{
                    backgroundColor:
                      e.priority >= 60
                        ? "hsl(354 75% 50% / 0.12)"
                        : e.priority >= 30
                          ? "hsl(38 95% 48% / 0.14)"
                          : "hsl(var(--surface-3))",
                    color:
                      e.priority >= 60
                        ? "hsl(354 75% 38%)"
                        : e.priority >= 30
                          ? "hsl(38 80% 28%)"
                          : "hsl(var(--ink-3))",
                  }}
                >
                  {e.priority}
                </span>
              </td>
              <td className="py-2">
                <div className="flex flex-wrap gap-1">
                  {e.reasons.map((r) => (
                    <Badge key={r} variant={REASON_META[r].variant}>
                      {REASON_META[r].label}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="py-2 text-right tabular-nums">
                {e.nightsOver4h}
                <span style={{ color: "hsl(var(--ink-3))" }}>
                  /{e.nightsWithData}
                </span>
              </td>
              <td className="py-2 text-right tabular-nums">
                {minutesToHours(e.avgUsageMinutes)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {fmt(e.avgAhi, 1)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {fmt(e.avgLeakLMin, 0)}
              </td>
              <td className="py-2 text-right text-xs">
                {e.lastNightDate ?? "—"}
                {e.daysSinceLastNight !== null && e.daysSinceLastNight > 1 && (
                  <span
                    className="block"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {e.daysSinceLastNight}d ago
                  </span>
                )}
              </td>
              <td className="py-2">
                <TriageCell
                  action={e.action}
                  pending={pendingPatientId === e.patientId}
                  onAction={(action, snoozeUntil) =>
                    onAction(e.patientId, action, snoozeUntil)
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ACTION_BADGE: Record<
  WorklistActionStatus,
  { variant: "info" | "warning" | "success" | "neutral"; label: string }
> = {
  acknowledged: { variant: "info", label: "Acknowledged" },
  snoozed: { variant: "neutral", label: "Snoozed" },
  contacted: { variant: "info", label: "Contacted" },
  resolved: { variant: "success", label: "Resolved" },
};

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

// Per-row triage controls: shows the current state (if any) plus quick
// actions. Snooze offers 7d/30d; the rest are single-click.
function TriageCell({
  action,
  pending,
  onAction,
}: {
  action: WorklistAction | null;
  pending: boolean;
  onAction: (action: WorklistActionStatus, snoozeUntil?: string) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {action && (
        <span className="inline-flex items-center gap-1">
          <Badge variant={ACTION_BADGE[action.status].variant}>
            {ACTION_BADGE[action.status].label}
            {action.status === "snoozed" && action.snoozeUntil
              ? ` → ${action.snoozeUntil}`
              : ""}
          </Badge>
        </span>
      )}
      <div
        className="flex items-center gap-1"
        style={{ opacity: pending ? 0.5 : 1 }}
      >
        <IconAction
          title="Mark contacted"
          disabled={pending}
          onClick={() => onAction("contacted")}
        >
          <PhoneCall className="h-3.5 w-3.5" />
        </IconAction>
        <IconAction
          title="Snooze 7 days"
          disabled={pending}
          onClick={() => onAction("snoozed", isoInDays(7))}
        >
          <BellOff className="h-3.5 w-3.5" />
          <span className="text-[10px] ml-0.5">7d</span>
        </IconAction>
        <IconAction
          title="Snooze 30 days"
          disabled={pending}
          onClick={() => onAction("snoozed", isoInDays(30))}
        >
          <BellOff className="h-3.5 w-3.5" />
          <span className="text-[10px] ml-0.5">30d</span>
        </IconAction>
        <IconAction
          title="Resolve (remove from queue)"
          disabled={pending}
          onClick={() => onAction("resolved")}
        >
          <Check className="h-3.5 w-3.5" />
        </IconAction>
      </div>
    </div>
  );
}

function IconAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center px-1.5 py-1 rounded border hover:bg-[hsl(var(--surface-2))] disabled:cursor-not-allowed"
      style={{
        borderColor: "hsl(var(--line-1))",
        color: "hsl(var(--ink-2))",
      }}
    >
      {children}
    </button>
  );
}
