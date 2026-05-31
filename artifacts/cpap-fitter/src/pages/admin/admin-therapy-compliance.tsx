// /admin/therapy-compliance — CMS 90-day setup-adherence tracker.
//
// Tracks every patient still inside their initial 90-day Medicare window
// and shows their BEST rolling 30-day count of >=4h nights (the CMS
// qualifying metric), how many qualifying nights they still need, days
// remaining, and whether they can still qualify. at-risk patients (can
// no longer reach 21 in time) sort to the top so a CSR can intervene
// before the claim is denied.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarClock, Download } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getSetupAdherenceSummary,
  getSetupAdherence,
  setupAdherenceCsvUrl,
  type SetupEntry,
  type SetupAdherenceStatus,
} from "@/lib/admin/therapy-compliance-api";

const STATUS_FILTERS: Array<{
  value: SetupAdherenceStatus | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "at_risk", label: "At risk" },
  { value: "on_track", label: "On track" },
  { value: "qualified", label: "Qualified" },
];

const STATUS_META: Record<
  SetupAdherenceStatus,
  { variant: "success" | "info" | "danger"; label: string }
> = {
  qualified: { variant: "success", label: "Qualified" },
  on_track: { variant: "info", label: "On track" },
  at_risk: { variant: "danger", label: "At risk" },
};

export function AdminTherapyCompliancePage() {
  const [status, setStatus] = useState<SetupAdherenceStatus | "all">("all");

  const summaryQ = useQuery({
    queryKey: ["admin", "therapy-compliance", "summary"],
    queryFn: getSetupAdherenceSummary,
    refetchOnWindowFocus: false,
  });
  const listQ = useQuery({
    queryKey: ["admin", "therapy-compliance", "setups", status],
    queryFn: () =>
      getSetupAdherence({
        limit: 200,
        status: status === "all" ? undefined : status,
      }),
    refetchOnWindowFocus: false,
  });

  const s = summaryQ.data?.summary;
  const inWindow = s?.patientsInWindow ?? 0;
  const qualRate =
    inWindow > 0 && s ? Math.round((s.qualified / inWindow) * 100) : 0;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CalendarClock className="h-6 w-6" /> 90-day setup adherence
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            New Medicare setups must reach 21 nights of ≥4h within a 30-day
            window during their first 90 days, or the claim is denied. Best
            rolling 30-day count and time remaining for every in-window patient.
          </p>
          <Link
            href="/admin/therapy-fleet"
            className="inline-flex items-center gap-1.5 text-sm mt-2 hover:underline"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            ← Back to therapy fleet
          </Link>
        </div>
        <a
          href={setupAdherenceCsvUrl({
            status: status === "all" ? undefined : status,
          })}
          download
        >
          <Button intent="secondary" size="sm">
            <Download className="h-4 w-4" /> Export
          </Button>
        </a>
      </header>

      {summaryQ.isError ? (
        <ErrorPanel
          error={summaryQ.error}
          onRetry={() => void summaryQ.refetch()}
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            label="In 90-day window"
            value={inWindow}
            isLoading={summaryQ.isPending}
            hint="New setups still being scored"
          />
          <KpiCard
            label="Qualified"
            value={summaryQ.isPending ? "—" : `${qualRate}%`}
            tone="gold"
            isLoading={summaryQ.isPending}
            hint={`${s?.qualified ?? 0} have hit 21 nights ≥4h`}
          />
          <KpiCard
            label="On track"
            value={s?.onTrack ?? 0}
            isLoading={summaryQ.isPending}
            hint="Can still qualify in time"
          />
          <KpiCard
            label="At risk"
            value={s?.atRisk ?? 0}
            isLoading={summaryQ.isPending}
            hint="Can no longer reach 21 — escalate"
          />
        </div>
      )}

      <Card
        title="Setups in their 90-day window"
        subtitle="At-risk first. Click a patient to review and intervene before the claim is denied."
      >
        <div className="flex flex-wrap gap-2 mb-4">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
              className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
              style={{
                backgroundColor:
                  status === f.value
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--surface-1))",
                color: status === f.value ? "white" : "hsl(var(--ink-2))",
                borderColor:
                  status === f.value
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--line-1))",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {listQ.isPending ? (
          <Spinner />
        ) : listQ.isError ? (
          <ErrorPanel
            error={listQ.error}
            onRetry={() => void listQ.refetch()}
          />
        ) : listQ.data.setups.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No setups match this filter.
          </p>
        ) : (
          <SetupTable setups={listQ.data.setups} />
        )}
      </Card>
    </div>
  );
}

function SetupTable({ setups }: { setups: SetupEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th className="py-2 font-semibold">Patient</th>
            <th className="py-2 font-semibold">Status</th>
            <th className="py-2 font-semibold">Best 30-day</th>
            <th className="py-2 font-semibold text-right">Nights needed</th>
            <th className="py-2 font-semibold text-right">Days left</th>
            <th className="py-2 font-semibold text-right">Started</th>
          </tr>
        </thead>
        <tbody>
          {setups.map((e) => (
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
                <Badge variant={STATUS_META[e.status].variant}>
                  {STATUS_META[e.status].label}
                </Badge>
              </td>
              <td className="py-2">
                <ProgressBar count={e.best30dayCount} goal={21} />
              </td>
              <td className="py-2 text-right tabular-nums">
                {e.status === "qualified" ? "—" : e.nightsNeeded}
              </td>
              <td className="py-2 text-right tabular-nums">
                {e.daysRemaining}
              </td>
              <td className="py-2 text-right text-xs">
                {e.firstNightDate ?? "—"}
                <span className="block" style={{ color: "hsl(var(--ink-3))" }}>
                  day {e.daysElapsed} of 90
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Compact "N / 21" progress toward the CMS qualifying threshold.
function ProgressBar({ count, goal }: { count: number; goal: number }) {
  const pct = Math.min(100, Math.round((count / goal) * 100));
  const met = count >= goal;
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-24 rounded-full overflow-hidden"
        style={{ backgroundColor: "hsl(var(--surface-3))" }}
      >
        <div
          className="h-full"
          style={{
            width: `${pct}%`,
            backgroundColor: met
              ? "hsl(152 60% 38%)"
              : pct >= 50
                ? "hsl(38 95% 48%)"
                : "hsl(354 75% 50%)",
          }}
        />
      </div>
      <span
        className="tabular-nums text-xs"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {count}/{goal}
      </span>
    </div>
  );
}
