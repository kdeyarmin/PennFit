// Patient-detail "Activity" tab — extracted from patient-detail.tsx.
//
// Broader timeline (coaching plans, grievances, recall notifications,
// address changes) from /admin/patients/:id/timeline.

import { useQuery } from "@tanstack/react-query";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { formatDateTime } from "@/lib/admin/format";
import { fetchPatientTimeline } from "@/lib/admin/patient-history-api";

export function ActivityTab({ patientId }: { patientId: string }) {
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["admin", "patients", patientId, "activity"] as const,
    queryFn: () => fetchPatientTimeline(patientId),
  });
  if (isPending) return <Spinner label="Loading activity…" />;
  if (isError) {
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }}>
        {error instanceof Error ? error.message : "Failed to load."}
      </p>
    );
  }
  if (data.events.length === 0) {
    return (
      <EmptyState
        title="No activity yet."
        hint="Episodes, conversations, video visits, grievances, recalls, and coaching plans all show here as they happen."
      />
    );
  }
  return (
    <ol className="space-y-2">
      {data.events.map((e) => (
        <li
          key={`${e.kind}-${e.refId}-${e.at}`}
          className="rounded border p-3 flex items-baseline justify-between gap-3"
          style={{ borderColor: "hsl(var(--line-2))" }}
        >
          <div className="min-w-0">
            <div className="text-sm font-medium">{e.title}</div>
            <div className="text-xs text-muted-foreground">{e.detail}</div>
          </div>
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatDateTime(e.at)}
          </span>
        </li>
      ))}
    </ol>
  );
}
