// /admin/billing/cmn — CMN/DIF draft worklist (Biller #29).
//
// Draft CMNs awaiting completion, with how many required fields remain.
// "Ready" rows just need a Complete click (do it from the patient card);
// each row links to the patient. reports.read. Ids + form/HCPCS only.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileCheck2 } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { getCmnWorklist } from "@/lib/admin/cmn-documents-api";

export function AdminBillingCmnWorklistPage() {
  const query = useQuery({
    queryKey: ["admin", "cmn-worklist"] as const,
    queryFn: getCmnWorklist,
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-cmn-worklist-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileCheck2 className="h-6 w-6" />
          CMN / DIF worklist
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Draft Certificates of Medical Necessity awaiting completion. Open the
          patient to fill the form and complete it.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading drafts…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No draft CMNs awaiting completion. 🎉
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Draft CMNs" value={query.data.count} />
            <KpiCard
              label="Ready to complete"
              value={query.data.readyToComplete}
              tone="gold"
            />
          </div>
          <Card title={`Drafts (${query.data.count})`}>
            <div className="space-y-2">
              {query.data.items.map((item) => (
                <div
                  key={item.id}
                  className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  data-testid="cmn-worklist-row"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <Badge variant={item.ready ? "success" : "warning"}>
                      {item.ready ? "ready" : `${item.missingCount} left`}
                    </Badge>
                    <span style={{ color: "hsl(var(--ink-2))" }}>
                      {item.formType}
                    </span>
                    <span
                      className="font-mono text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {item.hcpcsCode}
                    </span>
                  </span>
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
