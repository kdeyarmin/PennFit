// Provider RTM roster — "My patients": every patient the signed-in
// provider prescribes for, with a compact recent-adherence summary.
// Read-only. PHI is shown only to the MFA-gated, provider-scoped session
// (the server returns ONLY this provider's own patients).

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, Users } from "lucide-react";

import {
  getProviderRtmRoster,
  type RtmRosterPatient,
} from "@/lib/provider/provider-api";
import {
  Card,
  ErrorNote,
  ProviderShell,
  Spinner,
  formatDateTime,
} from "./provider-ui";

function fmtUsage(hours: number | null): string {
  if (hours == null) return "—";
  return `${hours.toFixed(1)} h`;
}

function fmtStale(staleDays: number | null): string {
  if (staleDays == null) return "No data yet";
  if (staleDays === 0) return "Last night";
  if (staleDays === 1) return "1 day ago";
  return `${staleDays} days ago`;
}

function ComplianceBadge({ patient }: { patient: RtmRosterPatient }) {
  if (!patient.hasData) {
    return (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
        No data
      </span>
    );
  }
  const pct = patient.complianceRatePct ?? 0;
  const cls = patient.cmsCompliant
    ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
    : pct >= 50
      ? "bg-amber-100 text-amber-800 ring-amber-200"
      : "bg-red-100 text-red-700 ring-red-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}
    >
      {pct}% compliant
    </span>
  );
}

export function ProviderPatients({
  providerName,
}: {
  providerName?: string | null;
}) {
  const query = useQuery({
    queryKey: ["provider", "rtm", "roster"],
    queryFn: () => getProviderRtmRoster(),
  });

  const patients = query.data?.patients ?? [];

  return (
    <ProviderShell providerName={providerName}>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">My patients</h1>
        <p className="mt-1 text-sm text-slate-500">
          Therapy adherence for the patients you prescribe for. Showing the last
          30 nights; open a patient for the full Medicare 90-day determination.
        </p>
      </div>

      {query.isPending ? (
        <Spinner label="Loading your patients…" />
      ) : query.isError ? (
        <ErrorNote>
          We couldn't load your patients. Please refresh and try again.
        </ErrorNote>
      ) : patients.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-sm text-slate-500">
            No patients are linked to your prescriptions yet.
          </p>
        </Card>
      ) : (
        <Card className="divide-y divide-slate-100">
          {patients.map((p) => (
            <Link
              key={p.patientId}
              href={`/provider/patients/${p.patientId}`}
              className="block hover:bg-slate-50"
            >
              <div className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                  <Activity className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-900">
                    {p.patientName}
                  </p>
                  <p className="truncate text-sm text-slate-500">
                    Avg usage {fmtUsage(p.avgUsageHours)} · {p.compliantNights}{" "}
                    of {p.nightsWithData} compliant nights ·{" "}
                    {fmtStale(p.staleDays)}
                  </p>
                </div>
                <ComplianceBadge patient={p} />
                <ChevronRight
                  className="h-5 w-5 shrink-0 text-slate-400"
                  aria-hidden="true"
                />
              </div>
            </Link>
          ))}
        </Card>
      )}

      {patients.length > 0 ? (
        <p className="mt-4 text-xs text-slate-400">
          Updated {formatDateTime(new Date().toISOString())}. Compliance =
          nights of ≥ 4 hours over the recent window.
        </p>
      ) : null}
    </ProviderShell>
  );
}
