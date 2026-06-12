// Patient-detail "Forms" tab — extracted from patient-detail.tsx.
//
// Read-only table of the patient's form acknowledgements, flagging
// signatures captured against an out-of-date form version.

import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { listPatientFormAcks } from "@/lib/admin/form-acks-api";

export function FormAcksTab({ patientId }: { patientId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "patients", patientId, "form-acks"] as const,
    queryFn: () => listPatientFormAcks(patientId),
  });
  if (isPending) return <Spinner />;
  if (isError) {
    return <ErrorPanel error={error} onRetry={() => void refetch()} />;
  }
  if (data.acknowledgements.length === 0) {
    return (
      <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
        No form acknowledgements on file for this patient.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Form</th>
          <th className="py-2 font-semibold">Signed version</th>
          <th className="py-2 font-semibold">Source</th>
          <th className="py-2 font-semibold">Signed</th>
        </tr>
      </thead>
      <tbody>
        {data.acknowledgements.map((a) => {
          const stale = a.currentVersion && a.formVersion !== a.currentVersion;
          return (
            <tr
              key={a.id}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2 font-medium">{a.formKind}</td>
              <td className="py-2">
                <span className="font-mono text-xs">{a.formVersion}</span>
                {stale && (
                  <span
                    className="ml-2 inline-block px-1 py-0.5 rounded text-[10px] uppercase"
                    style={{
                      backgroundColor: "hsl(var(--alert-bg))",
                      color: "hsl(var(--alert))",
                    }}
                  >
                    out of date
                  </span>
                )}
              </td>
              <td
                className="py-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {a.source}
              </td>
              <td className="py-2 text-xs">
                {new Date(a.signedAt).toLocaleDateString()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
