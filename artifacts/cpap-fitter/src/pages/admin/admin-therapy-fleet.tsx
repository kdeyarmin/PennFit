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
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  Download,
  HeartPulse,
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
  getFleetWorklist,
  fleetWorklistCsvUrl,
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
  const [windowDays, setWindowDays] = useState<number>(30);
  const [reason, setReason] = useState<WorklistReason | null>(null);

  const overviewQ = useQuery({
    queryKey: ["admin", "therapy-fleet", "overview", windowDays],
    queryFn: () => getFleetOverview(windowDays),
    refetchOnWindowFocus: false,
  });
  const worklistQ = useQuery({
    queryKey: ["admin", "therapy-fleet", "worklist", windowDays, reason],
    queryFn: () =>
      getFleetWorklist({
        windowDays,
        limit: 200,
        reason: reason ?? undefined,
      }),
    refetchOnWindowFocus: false,
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
          <WorklistTable entries={worklistQ.data.entries} />
        )}
      </Card>
    </div>
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

function WorklistTable({ entries }: { entries: WorklistEntry[] }) {
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
