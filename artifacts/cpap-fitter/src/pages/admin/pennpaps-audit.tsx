import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/admin/ui-shims";
import { Skeleton } from "@/components/admin/ui-shims";
import { Button } from "@/components/admin/ui-shims";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { fetchAdminAuditLog } from "@/lib/admin/storefront-admin-api";
import { auditActionLabel } from "@/lib/admin/storefront-admin-labels";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";

export function AdminAuditLog() {
  useDocumentTitle("Admin · Activity history");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["admin-audit", { page, pageSize }],
    queryFn: () => fetchAdminAuditLog({ page, pageSize }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <h1
          className="text-display text-3xl font-bold tracking-tight"
          data-testid="admin-page-title"
        >
          Activity history
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A read-only paper trail of what each admin and customer-service rep
          has done — for example, which patient records were opened or which
          reminder batches were sent. Use this when you need to retrace your
          steps or answer "who looked at this order?".
        </p>
      </div>

      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                <tr>
                  <th className="text-left py-3 px-4">When</th>
                  <th className="text-left py-3 px-4">Who</th>
                  <th className="text-left py-3 px-4">What they did</th>
                  <th className="text-left py-3 px-4">Order opened</th>
                  <th className="text-left py-3 px-4">From IP</th>
                </tr>
              </thead>
              <tbody>
                {isLoading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td colSpan={5} className="py-3 px-4">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))}
                {!isLoading && isError && (
                  <tr>
                    <td colSpan={5} className="py-6 px-4">
                      <ErrorPanel
                        error={error}
                        onRetry={() => void refetch()}
                        title="Couldn't load the activity history"
                      />
                    </td>
                  </tr>
                )}
                {!isLoading && !isError && data && data.events.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-12 text-center text-muted-foreground"
                    >
                      Nothing recorded yet — once admins start opening orders or
                      sending reminders, their actions will appear here.
                    </td>
                  </tr>
                )}
                {data?.events.map((ev) => (
                  <tr key={ev.id} className="border-t border-border/40">
                    <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                      {new Date(ev.occurredAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">{ev.adminEmail}</td>
                    <td className="py-3 px-4" title={ev.action}>
                      {auditActionLabel(ev.action)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs">
                      {ev.targetOrderId ? (
                        <Link
                          href={`/admin/pennpaps/orders/${ev.targetOrderId}`}
                          className="text-primary hover:underline"
                          title="Open this order"
                        >
                          {ev.targetOrderId.slice(0, 8)}…
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground font-mono text-xs">
                      {ev.ip ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {data && data.total > pageSize && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {data.page} of {totalPages} · {data.total} total
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
