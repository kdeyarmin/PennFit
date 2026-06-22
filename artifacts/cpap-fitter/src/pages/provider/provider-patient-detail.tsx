// Provider RTM — one patient's therapy detail. Shows the recent-window
// adherence rollup plus the authoritative Medicare LCD L33718 90-day
// determination, and lets the provider open the adherence attestation
// PDF. Read-only, provider-scoped, MFA-gated (server-enforced).

import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileText } from "lucide-react";

import {
  getProviderRtmPatient,
  providerAttestationPdfUrl,
  type RtmPatientDetail,
} from "@/lib/provider/provider-api";
import { Button, Card, ErrorNote, ProviderShell, Spinner } from "./provider-ui";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function CmsDetermination({ data }: { data: RtmPatientDetail }) {
  const cms = data.cms;
  if (!cms) {
    return (
      <Card className="p-5">
        <h2 className="font-semibold text-slate-900">
          Medicare 90-day determination
        </h2>
        <p className="mt-2 text-sm text-slate-500">
          No therapy-night data on file yet — the 90-day adherence window can't
          be evaluated.
        </p>
      </Card>
    );
  }
  const headline = cms.qualifies
    ? "Qualifies — meets Medicare LCD L33718"
    : cms.horizonComplete
      ? "Does not qualify — 90-day horizon complete"
      : "Interim — does not yet qualify";
  const headlineCls = cms.qualifies
    ? "text-emerald-700"
    : cms.horizonComplete
      ? "text-red-700"
      : "text-amber-700";
  return (
    <Card className="p-5">
      <h2 className="font-semibold text-slate-900">
        Medicare 90-day determination
      </h2>
      <p className={`mt-2 text-sm font-semibold ${headlineCls}`}>{headline}</p>
      {cms.window ? (
        <p className="mt-2 text-sm text-slate-600">
          Best 30-day window: {cms.window.compliantNights} of 30 compliant
          nights ({cms.window.ratioPct}%) from {fmtDate(cms.window.startDate)}{" "}
          through {fmtDate(cms.window.endDate)}.
          {cms.window.averageUsageHours != null
            ? ` Avg ${cms.window.averageUsageHours.toFixed(1)} h on nights with data.`
            : ""}
        </p>
      ) : (
        <p className="mt-2 text-sm text-slate-500">
          Not enough elapsed therapy data for a full 30-day window yet.
        </p>
      )}
    </Card>
  );
}

export function ProviderPatientDetail({
  id,
  providerName,
}: {
  id: string;
  providerName?: string | null;
}) {
  const query = useQuery({
    queryKey: ["provider", "rtm", "patient", id],
    queryFn: () => getProviderRtmPatient(id),
    retry: false,
  });

  return (
    <ProviderShell providerName={providerName}>
      <div className="mb-5">
        <Link
          href="/provider/patients"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 hover:text-blue-800"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to my patients
        </Link>
      </div>

      {query.isPending ? (
        <Spinner label="Loading patient…" />
      ) : query.isError ? (
        <ErrorNote>
          We couldn't load this patient. They may not be linked to your
          prescriptions.
        </ErrorNote>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                {query.data.patientName}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                Therapy start: {fmtDate(query.data.setupDate)}
              </p>
            </div>
            <a
              href={providerAttestationPdfUrl(id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="secondary">
                <FileText className="h-4 w-4" aria-hidden="true" />
                Adherence attestation (PDF)
              </Button>
            </a>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Avg usage"
              value={
                query.data.snapshot.avgUsageHours != null
                  ? `${query.data.snapshot.avgUsageHours.toFixed(1)} h`
                  : "—"
              }
            />
            <Stat
              label="Compliance"
              value={
                query.data.snapshot.complianceRatePct != null
                  ? `${query.data.snapshot.complianceRatePct}%`
                  : "—"
              }
            />
            <Stat
              label="Avg AHI"
              value={
                query.data.snapshot.avgAhi != null
                  ? query.data.snapshot.avgAhi.toFixed(1)
                  : "—"
              }
            />
            <Stat
              label="Last night"
              value={fmtDate(query.data.snapshot.lastNightDate)}
            />
          </div>

          <CmsDetermination data={query.data} />

          <p className="text-xs text-slate-400">
            Recent window: {query.data.snapshot.nightsWithData} nights with data
            over the last {query.data.snapshot.windowDays} days. Compliance
            counts nights of ≥ 4 hours.
          </p>
        </div>
      )}
    </ProviderShell>
  );
}
