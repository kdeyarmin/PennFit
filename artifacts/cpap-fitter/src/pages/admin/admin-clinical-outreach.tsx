// /admin/clinical/outreach — proactive clinical outreach worklist (RT #23).
//
// Patients with an open intervention who are due for a check-in (not
// contacted within the frequency-cap window). "Send check-ins" fires the
// capped, consent/DND-gated batch — patients who've opted out or are in
// quiet hours come back skipped. Category + ids only (no PHI).
//
// clinical.read to view; sending needs clinical.intervention.write
// (enforced server-side).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Send } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getOutreachEligible,
  runOutreachBatch,
  type OutreachBatchSummary,
} from "@/lib/admin/clinical-outreach-api";

const QUERY_KEY = ["admin", "clinical-outreach-eligible"] as const;

export function AdminClinicalOutreachPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getOutreachEligible,
    staleTime: 30_000,
  });

  const batch = useMutation({
    mutationFn: () => runOutreachBatch(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-clinical-outreach-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Send className="h-6 w-6" />
            Clinical outreach
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Patients with an open non-adherence intervention who are due for a
            supportive check-in. Sending honors each patient&apos;s
            communication preferences and quiet hours — opted-out patients come
            back skipped.
          </p>
        </div>
        {query.data && query.data.count > 0 && (
          <Button isLoading={batch.isPending} onClick={() => batch.mutate()}>
            Send check-ins
          </Button>
        )}
      </header>

      {batch.data && <SummaryLine summary={batch.data.summary} />}
      {batch.error instanceof Error && (
        <div className="text-xs" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t run outreach — you may not have permission, or the
          messaging provider is unreachable.
        </div>
      )}

      {query.isPending ? (
        <Spinner label="Loading eligible patients…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No patients are due for outreach right now. 🎉
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Due for outreach" value={query.data.count} />
          </div>
          <Card title={`Eligible (${query.data.count})`}>
            <div className="space-y-2">
              {query.data.eligible.map((item) => (
                <div
                  key={`${item.patientId}-${item.interventionId ?? ""}`}
                  className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  data-testid="outreach-eligible-row"
                >
                  <Badge variant="info">{item.category ?? "other"}</Badge>
                  <Link
                    href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
                    className="text-xs underline decoration-dotted font-mono truncate"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {item.patientId}
                  </Link>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function SummaryLine({ summary }: { summary: OutreachBatchSummary }) {
  return (
    <div
      className="rounded border px-3 py-2 text-xs"
      style={{ borderColor: "hsl(var(--line-1))", color: "hsl(var(--ink-2))" }}
      role="status"
    >
      Last run — selected {summary.selected}, sent {summary.sent}
      {summary.skipped > 0 ? `, skipped ${summary.skipped}` : ""}
      {summary.failed > 0 ? `, failed ${summary.failed}` : ""}.
    </div>
  );
}
