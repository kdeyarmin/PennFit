// PatientResupplyTab — per-patient therapy 360.
//
// Pulls the single-round-trip aggregate at
// /admin/patients/:id/resupply-summary and renders:
//
//   1. Adherence headline (Medicare 30-day yardstick: 21/30 nights
//      ≥ 4hr usage = compliant; verdict + raw fraction).
//   2. Median nightly usage / AHI / leak rate over the same window.
//   3. Open smart-trigger events (leak_rising, usage_dropping, …).
//   4. Open compliance alerts (low_usage, no_response, …).
//   5. Recent therapy-nights table (last 14 of the 60 returned).
//
// The data fed in is therapy PHI (usage / AHI / leak), so the
// component renders inside the existing patient-detail tab
// container which already passes the admin auth gate.

import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Activity,
  ClipboardList,
  Gauge,
  TrendingUp,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";

const BASE = "/resupply-api";

interface AdherenceSummary {
  windowDays: number;
  windowNightsAvailable: number;
  nightsCompliant: number;
  minCompliantNightsForMedicare: number;
  minUsageMinutesForCompliantNight: number;
  adherenceFraction: number | null;
  meetsMedicareBar: boolean;
  medianUsageMinutes: number | null;
  medianAhi: number | null;
  medianLeakRateLMin: number | null;
}

interface TherapyNight {
  id: string;
  nightDate: string;
  source: string;
  usageMinutes: number | null;
  ahi: number | null;
  leakRateLMin: number | null;
  pressureP95Cmh2o: number | null;
}

interface SmartTrigger {
  id: string;
  kind: "leak_rising" | "usage_dropping" | "cushion_wear" | "humidifier_drop";
  detectedAt: string;
  windowStartDate: string;
  windowEndDate: string;
  sentAt: string | null;
}

interface ComplianceAlert {
  id: string;
  alertType: "low_usage" | "no_response" | "send_failure" | "manual";
  severity: "info" | "warning" | "critical";
  summary: string;
  status: "open" | "snoozed" | "resolved";
  snoozedUntil: string | null;
  createdAt: string;
}

interface ResupplySummaryResponse {
  adherence: AdherenceSummary;
  nights: TherapyNight[];
  smartTriggers: SmartTrigger[];
  complianceAlerts: ComplianceAlert[];
  counts: {
    nightsOnFile: number;
    smartTriggersOpen: number;
    complianceAlertsOpen: number;
  };
  generatedAt: string;
}

const TRIGGER_LABEL: Record<SmartTrigger["kind"], string> = {
  leak_rising: "Leak rising",
  usage_dropping: "Usage dropping",
  cushion_wear: "Cushion wear",
  humidifier_drop: "Humidifier drop",
};

const ALERT_TYPE_LABEL: Record<ComplianceAlert["alertType"], string> = {
  low_usage: "Low usage",
  no_response: "No response",
  send_failure: "Send failure",
  manual: "Manual",
};

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

function formatHours(minutes: number | null): string {
  if (minutes == null) return "—";
  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}

function formatPercent(fraction: number | null): string {
  if (fraction == null || Number.isNaN(fraction)) return "—";
  return `${Math.round(fraction * 100)}%`;
}

export function PatientResupplyTab({ patientId }: { patientId: string }) {
  const summary = useQuery({
    queryKey: ["patient-resupply-summary", patientId],
    queryFn: () =>
      getJSON<ResupplySummaryResponse>(
        `/admin/patients/${patientId}/resupply-summary`,
      ),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  if (summary.isError) {
    return (
      <ErrorPanel
        error={summary.error}
        onRetry={() => void summary.refetch()}
      />
    );
  }
  if (summary.isPending) {
    return <Spinner label="Loading therapy data…" />;
  }
  const data = summary.data;

  return (
    <div className="admin-root space-y-6" data-testid="patient-resupply-tab">
      <AdherenceCard adherence={data.adherence} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Smart triggers
            </span>
          }
          subtitle={`${data.counts.smartTriggersOpen} open in the last 30 days`}
        >
          {data.smartTriggers.length === 0 ? (
            <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
              No triggers firing. Therapy is steady.
            </p>
          ) : (
            <ul
              className="divide-y -mt-1 -mb-1"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {data.smartTriggers.map((t) => (
                <li
                  key={t.id}
                  className="py-2 text-sm flex items-center justify-between gap-3"
                >
                  <div>
                    <span
                      className="font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {TRIGGER_LABEL[t.kind]}
                    </span>
                    <span
                      className="ml-2 text-[11px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      window {t.windowStartDate} → {t.windowEndDate}
                    </span>
                  </div>
                  <span
                    className="text-[11px]"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {t.sentAt ? (
                      <>sent {new Date(t.sentAt).toLocaleDateString()}</>
                    ) : (
                      <>queued</>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={
            <span className="inline-flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              Compliance alerts
            </span>
          }
          subtitle={`${data.counts.complianceAlertsOpen} open in the last 90 days`}
        >
          {data.complianceAlerts.length === 0 ? (
            <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
              No open alerts.
            </p>
          ) : (
            <ul
              className="divide-y -mt-1 -mb-1"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {data.complianceAlerts.map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2">
                      <SeverityBadge severity={a.severity} />
                      <span
                        className="font-medium"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {ALERT_TYPE_LABEL[a.alertType]}
                      </span>
                      {a.status === "snoozed" && (
                        <span
                          className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full"
                          style={{
                            backgroundColor: "rgba(180,83,9,0.12)",
                            color: "#b45309",
                          }}
                        >
                          snoozed
                        </span>
                      )}
                    </span>
                    <span
                      className="text-[11px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {new Date(a.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p
                    className="text-[12px] mt-0.5"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {a.summary}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <ClipboardList className="h-4 w-4" />
            Recent therapy nights
          </span>
        }
        subtitle={`${data.counts.nightsOnFile} on file; showing the last 14`}
      >
        {data.nights.length === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No therapy data on file yet. Run a sync from the Integrations tab
            when the partner ID is captured.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Date</th>
                  <th className="p-3">Source</th>
                  <th className="p-3 text-right">Usage</th>
                  <th className="p-3 text-right">AHI</th>
                  <th className="p-3 text-right">Leak (L/min)</th>
                  <th className="p-3 text-right">P95 pressure</th>
                </tr>
              </thead>
              <tbody>
                {data.nights.slice(0, 14).map((n) => (
                  <tr
                    key={n.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="p-3 tabular-nums"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {n.nightDate}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {n.source}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums"
                      style={{
                        color:
                          (n.usageMinutes ?? 0) >= 240
                            ? "#15803d"
                            : "hsl(var(--ink-1))",
                      }}
                    >
                      {formatHours(n.usageMinutes)}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums"
                      style={{
                        color:
                          (n.ahi ?? 0) >= 5 ? "#b45309" : "hsl(var(--ink-1))",
                      }}
                    >
                      {n.ahi == null ? "—" : n.ahi.toFixed(1)}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {n.leakRateLMin == null ? "—" : n.leakRateLMin.toFixed(1)}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {n.pressureP95Cmh2o == null
                        ? "—"
                        : `${n.pressureP95Cmh2o.toFixed(1)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function AdherenceCard({ adherence }: { adherence: AdherenceSummary }) {
  // CMS 90-day initial-coverage rule: 21 of any 30 nights ≥ 4hr.
  // Surface verdict + raw fraction so the CSR doesn't have to do
  // the math.
  const tone = adherence.meetsMedicareBar
    ? { color: "#15803d", bg: "rgba(21, 128, 61, 0.10)", label: "On track" }
    : adherence.windowNightsAvailable === 0
      ? {
          color: "hsl(var(--ink-3))",
          bg: "rgba(0,0,0,0.04)",
          label: "No data",
        }
      : {
          color: "#b45309",
          bg: "rgba(180, 83, 9, 0.12)",
          label: "Below CMS bar",
        };

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Gauge className="h-4 w-4" />
          Adherence — {adherence.windowDays}-day window
        </span>
      }
      subtitle="CMS counts a compliant night as ≥ 4 hours of usage; ongoing payment needs ≥ 70% of nights"
      action={
        <span
          className="inline-block px-2 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: tone.color, backgroundColor: tone.bg }}
        >
          {tone.label}
        </span>
      }
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat
          label="Compliant nights"
          value={`${adherence.nightsCompliant}/${adherence.windowNightsAvailable}`}
          hint={`${formatPercent(adherence.adherenceFraction)} of nights`}
        />
        <Stat
          label="Median usage"
          value={formatHours(adherence.medianUsageMinutes)}
          hint="Per-night median"
          icon={<Activity className="h-3.5 w-3.5" />}
        />
        <Stat
          label="Median AHI"
          value={
            adherence.medianAhi == null ? "—" : adherence.medianAhi.toFixed(1)
          }
          hint="< 5 is good"
        />
        <Stat
          label="Median leak"
          value={
            adherence.medianLeakRateLMin == null
              ? "—"
              : `${adherence.medianLeakRateLMin.toFixed(1)} L/min`
          }
          hint="< 24 is in-range"
        />
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1 inline-flex items-center gap-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {icon}
        {label}
      </p>
      <p
        className="text-xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </p>
      {hint && (
        <p className="text-[11px] mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function SeverityBadge({
  severity,
}: {
  severity: ComplianceAlert["severity"];
}) {
  const tone = (() => {
    switch (severity) {
      case "critical":
        return { bg: "rgba(185, 28, 28, 0.12)", color: "#b91c1c" };
      case "warning":
        return { bg: "rgba(180, 83, 9, 0.12)", color: "#b45309" };
      case "info":
        return { bg: "rgba(29, 78, 216, 0.10)", color: "#1d4ed8" };
    }
  })();
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: tone.color, backgroundColor: tone.bg }}
    >
      {severity}
    </span>
  );
}
