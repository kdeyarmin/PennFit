// /admin/rt-outcomes — per-RT outcomes dashboard (Phase 3, RT #24).
//
// "What is each respiratory therapist actually moving?" — encounters
// authored, distinct patients managed, follow-ups committed, and
// interventions logged, per author over a selectable window. Derived
// from the F3 clinical_encounters log (counts only; no patient ids or
// clinical text cross the wire). clinical.read-gated, so an RT sees the
// team's counts and management sees the whole board.
//
// Adherence-lift ("did usage actually improve?") needs a therapy-metric
// before/after join and is a deliberate follow-up — surfaced as an
// honest note rather than a fabricated outcome number.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Stethoscope } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchRtOutcomes,
  RT_ENCOUNTER_TYPES,
  type RtEncounterType,
  type RtOutcomeRow,
} from "@/lib/admin/rt-outcomes-api";

const WINDOWS: ReadonlyArray<{ days: number; label: string }> = [
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
];

const TYPE_LABEL: Record<RtEncounterType, string> = {
  mask_fit: "Mask fit",
  troubleshoot: "Troubleshoot",
  setup_education: "Setup ed.",
  adherence_intervention: "Intervention",
  phone: "Phone",
  other: "Other",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffDays = Math.floor((Date.now() - t) / 86_400_000);
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(t).toLocaleDateString();
}

export function AdminRtOutcomesPage() {
  const [windowDays, setWindowDays] = useState(90);
  const query = useQuery({
    queryKey: ["admin", "rt-outcomes", windowDays] as const,
    queryFn: () => fetchRtOutcomes(windowDays),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-rt-outcomes-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Stethoscope className="h-6 w-6" />
          RT outcomes
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Per-therapist activity from documented clinical encounters — patients
          managed, follow-ups committed, and interventions logged. Counts only;
          no patient detail leaves the clinical record.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Time window"
        className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
      >
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            role="tab"
            aria-selected={w.days === windowDays}
            onClick={() => setWindowDays(w.days)}
            className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
              w.days === windowDays
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading RT outcomes…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="Active RTs"
              value={query.data.totals.rts}
              hint={`last ${windowDays} days`}
            />
            <KpiCard label="Encounters" value={query.data.totals.encounters} />
            <KpiCard
              label="Patients managed"
              value={query.data.totals.patientsManaged}
              tone="gold"
            />
            <KpiCard
              label="Follow-ups committed"
              value={query.data.totals.followUpsCommitted}
            />
          </div>

          {query.data.rows.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No documented encounters in the last {windowDays} days.
              </p>
            </Card>
          ) : (
            <Card title={`By therapist (${query.data.rows.length})`}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr
                      className="text-left text-[10px] uppercase tracking-wider"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <th className="py-2 pr-3 font-semibold">Therapist</th>
                      <th className="py-2 px-2 font-semibold text-right">
                        Enc.
                      </th>
                      <th className="py-2 px-2 font-semibold text-right">
                        Patients
                      </th>
                      <th className="py-2 px-2 font-semibold text-right">
                        Follow-ups
                      </th>
                      <th className="py-2 px-2 font-semibold text-right">
                        Interv.
                      </th>
                      <th className="py-2 pl-2 font-semibold">Mix</th>
                      <th className="py-2 pl-3 font-semibold text-right">
                        Last active
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((r) => (
                      <RtRow key={r.authorEmail} row={r} />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            <strong>Adherence lift</strong> (whether usage improved after an
            intervention) is not yet shown — it needs a therapy-metric
            before/after comparison and is tracked as a follow-up. These figures
            are activity, not yet measured outcome.
          </p>
        </>
      )}
    </div>
  );
}

function RtRow({ row }: { row: RtOutcomeRow }) {
  const mix = RT_ENCOUNTER_TYPES.filter((t) => row.byType[t] > 0)
    .map((t) => `${TYPE_LABEL[t]} ${row.byType[t]}`)
    .join(" · ");
  return (
    <tr
      className="border-t"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="rt-outcome-row"
    >
      <td
        className="py-2 pr-3 font-medium"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {row.authorEmail}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {row.encountersTotal}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {row.patientsManaged}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">
        {row.followUpsCommitted}
      </td>
      <td className="py-2 px-2 text-right tabular-nums">{row.interventions}</td>
      <td className="py-2 pl-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        {mix || "—"}
      </td>
      <td
        className="py-2 pl-3 text-right text-xs whitespace-nowrap"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {formatWhen(row.lastActiveAt)}
      </td>
    </tr>
  );
}
