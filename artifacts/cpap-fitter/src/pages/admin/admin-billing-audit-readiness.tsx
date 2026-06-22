// /admin/billing/audit-readiness — proactive audit-gap worklist.
//
// Patients with billed (auditable) claims who are SHORT on the audit-critical
// chart documents, ranked by billed dollars at risk. Chase the paperwork here
// before an ADR or denial arrives. reports.read.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ClipboardCheck } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { getAuditReadinessWorklist } from "@/lib/admin/audit-readiness-worklist-api";

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function AdminBillingAuditReadinessPage() {
  const query = useQuery({
    queryKey: ["admin", "audit-readiness-worklist"] as const,
    queryFn: getAuditReadinessWorklist,
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-audit-readiness-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6" />
          Audit readiness
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Patients with billed claims who are missing audit-critical
          documentation, highest billed dollars first. Chase the paperwork now —
          before an ADR or a denial forces the issue.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Checking audit readiness…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No document-short patients found among billed claims. Every audited
            claim's chart documents appear to be on file.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard
              label="Patients document-short"
              value={query.data.counts.short}
            />
            <KpiCard
              label="Billed $ at risk"
              value={dollars(query.data.counts.billedAtRiskCents)}
              tone="gold"
            />
          </div>
          <Card title={`Document-short patients (${query.data.items.length})`}>
            <div className="space-y-2">
              {query.data.items.map((item) => (
                <div
                  key={item.patientId}
                  className="rounded border p-3 space-y-2"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                  data-testid="audit-readiness-row"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="flex items-center gap-2 text-sm">
                      <Badge variant="warning">
                        {Math.round(item.score * 100)}% ready
                      </Badge>
                      <Link
                        href={`/admin/patients/${item.patientId}`}
                        className="font-medium underline"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {item.patientName}
                      </Link>
                      <span style={{ color: "hsl(var(--ink-3))" }}>
                        {item.auditableClaims} claim
                        {item.auditableClaims === 1 ? "" : "s"}
                      </span>
                    </span>
                    <span
                      className="text-xs flex items-center gap-3"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <span>{dollars(item.billedCents)} billed</span>
                      <Link
                        href={`/admin/audit-packet?patientId=${item.patientId}&scope=device`}
                        className="underline"
                        style={{ color: "hsl(var(--penn-navy))" }}
                      >
                        Build packet →
                      </Link>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {item.missing.map((label) => (
                      <Badge key={label} variant="neutral">
                        {label}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
