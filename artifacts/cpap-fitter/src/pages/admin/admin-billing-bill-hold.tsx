// /admin/billing/bill-hold — the bill-hold worklist (0253).
//
// Every claim currently held from billing because it still owes a signed
// document, oldest-held first, with what each is waiting on. Work a row by
// opening the patient to chase / file the paperwork; the hold lifts
// automatically when the last required document is back (manual mark, portal
// e-sign, upload, or an inbound fax auto-matched to it). reports.read.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileLock2 } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { getBillHoldWorklist } from "@/lib/admin/bill-hold-api";

function dollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function heldDays(since: string | null): number | null {
  if (!since) return null;
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function AdminBillingBillHoldPage() {
  const query = useQuery({
    queryKey: ["admin", "bill-hold-worklist"] as const,
    queryFn: getBillHoldWorklist,
    staleTime: 30_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-bill-hold-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileLock2 className="h-6 w-6" />
          Bill hold worklist
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Claims held from billing until their signed paperwork is back. Open
          the patient to chase or file the document — the hold lifts
          automatically when the last required item returns (including a signed
          fax auto-matched to it).
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading held claims…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No claims are on bill hold. Every claim with tracked paperwork has
            it on file. 🎉
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Claims on hold" value={query.data.count} />
            <KpiCard
              label="Held billed $"
              value={dollars(query.data.totalHeldCents)}
              tone="gold"
            />
          </div>
          <Card title={`Held claims (${query.data.count})`}>
            <div className="space-y-2">
              {query.data.items.map((item) => {
                const days = heldDays(item.heldSince);
                return (
                  <div
                    key={item.claimId}
                    className="rounded border p-3 space-y-2"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                    data-testid="bill-hold-row"
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <span className="flex items-center gap-2 text-sm">
                        <Badge variant="warning">on hold</Badge>
                        <Link
                          href={`/admin/patients/${item.patientId}`}
                          className="font-medium underline"
                          style={{ color: "hsl(var(--ink-1))" }}
                        >
                          {item.patientName}
                        </Link>
                        <span style={{ color: "hsl(var(--ink-3))" }}>
                          {item.payerName}
                        </span>
                      </span>
                      <span
                        className="text-xs flex items-center gap-3"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {item.dateOfService ? (
                          <span>DOS {item.dateOfService}</span>
                        ) : null}
                        <span>{dollars(item.totalBilledCents)}</span>
                        {days != null ? <span>held {days}d</span> : null}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {item.outstanding.length === 0 ? (
                        <span
                          className="text-xs"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {item.reason ?? "Waiting on signed paperwork."}
                        </span>
                      ) : (
                        item.outstanding.map((o, i) => (
                          <Badge key={i} variant="neutral">
                            {o.label}
                          </Badge>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
