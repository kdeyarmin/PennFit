// /admin/accreditation-binder — surveyor-facing rollup of how many
// active patients have signed each required intake form. Surveyors
// (ACHC / BOC / TJC) ask this exact question during DMEPOS site
// visits; the binder answers it without sifting PDFs.

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { getFormAckSummary } from "@/lib/admin/form-acks-api";

export function AdminAccreditationBinderPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "accreditation", "form-ack-summary"] as const,
    queryFn: getFormAckSummary,
  });
  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" /> Accreditation binder
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Coverage of required intake forms across the active patient
          population. Surveyors expect &gt;95% on the current version
          of each form.
        </p>
      </header>
      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <SummaryTable rows={data.summary} />
        )}
      </Card>
    </div>
  );
}

function SummaryTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof getFormAckSummary>>["summary"];
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Form</th>
          <th className="py-2 font-semibold">Current version</th>
          <th className="py-2 font-semibold">Active patients</th>
          <th className="py-2 font-semibold">Signed current</th>
          <th className="py-2 font-semibold">Signed older</th>
          <th className="py-2 font-semibold">Never signed</th>
          <th className="py-2 font-semibold">Compliance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const compliance =
            r.activePatients === 0
              ? 100
              : Math.round((r.signedCurrent / r.activePatients) * 100);
          const good = compliance >= 95;
          const ok = compliance >= 80 && compliance < 95;
          return (
            <tr
              key={r.formKind}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2 font-medium">{r.title}</td>
              <td className="py-2 font-mono text-xs">{r.currentVersion}</td>
              <td className="py-2 tabular-nums">{r.activePatients}</td>
              <td className="py-2 tabular-nums">{r.signedCurrent}</td>
              <td className="py-2 tabular-nums">{r.signedOld}</td>
              <td className="py-2 tabular-nums">{r.neverSigned}</td>
              <td className="py-2">
                <span
                  style={{
                    color: good
                      ? "hsl(142,72%,29%)"
                      : ok
                        ? "hsl(38,92%,45%)"
                        : "hsl(0,84%,45%)",
                    fontWeight: 600,
                  }}
                >
                  {compliance}%
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
