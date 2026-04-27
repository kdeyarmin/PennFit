import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { fetchAdminAuditLog } from "@/lib/admin-api";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function AdminAuditLog() {
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const { data, isLoading } = useQuery({
    queryKey: ["admin-audit", { page, pageSize }],
    queryFn: () => fetchAdminAuditLog({ page, pageSize }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-display text-3xl font-bold tracking-tight" data-testid="admin-page-title">
          Audit log
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every time an admin opens an individual patient record or runs a name search, a row
          is appended here. Listing the orders index does not log.
        </p>
      </div>

      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                <tr>
                  <th className="text-left py-3 px-4">When</th>
                  <th className="text-left py-3 px-4">Admin</th>
                  <th className="text-left py-3 px-4">Action</th>
                  <th className="text-left py-3 px-4">Target order</th>
                  <th className="text-left py-3 px-4">IP</th>
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
                {!isLoading && data && data.events.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-12 text-center text-muted-foreground">
                      No audit events yet.
                    </td>
                  </tr>
                )}
                {data?.events.map((ev) => (
                  <tr key={ev.id} className="border-t border-border/40">
                    <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                      {new Date(ev.occurredAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4">{ev.adminEmail}</td>
                    <td className="py-3 px-4 font-mono text-xs">{ev.action}</td>
                    <td className="py-3 px-4 font-mono text-xs">
                      {ev.targetOrderId ? (
                        <Link
                          href={`/admin/orders/${ev.targetOrderId}`}
                          className="text-primary hover:underline"
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
