import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAdminOrders } from "@/lib/admin-api";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  sent: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
};
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  sent: "default",
  failed: "destructive",
  skipped: "secondary",
};

export function AdminOrders() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Debounce search input by 300ms so we don't audit-log on every keystroke.
  // (Search hits the audit table.)
  if (q !== debouncedQ) {
    // simple useEffect-less debounce via setTimeout in a microtask.
    setTimeout(() => setDebouncedQ(q), 300);
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-orders", { q: debouncedQ, status, page, pageSize }],
    queryFn: () =>
      fetchAdminOrders({
        q: debouncedQ || undefined,
        status,
        page,
        pageSize,
      }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-display text-3xl font-bold tracking-tight" data-testid="admin-page-title">
            Orders
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            All orders submitted through Penn Fit. Click a row to view full patient detail.
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or reference"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="pl-9"
              data-testid="input-admin-search"
            />
          </div>
          <Select
            value={status ?? "all"}
            onValueChange={(v) => {
              setStatus(v === "all" ? undefined : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-full sm:w-44" data-testid="select-admin-status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="sent">Delivered</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="skipped">Skipped</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                <tr>
                  <th className="text-left py-3 px-4">Reference</th>
                  <th className="text-left py-3 px-4">Patient</th>
                  <th className="text-left py-3 px-4">Email</th>
                  <th className="text-left py-3 px-4">Mask</th>
                  <th className="text-left py-3 px-4">Ship to</th>
                  <th className="text-left py-3 px-4">Status</th>
                  <th className="text-left py-3 px-4">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {isLoading &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={`skel-${i}`} className="border-t border-border/40">
                      <td colSpan={7} className="py-3 px-4">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))}
                {!isLoading && data && data.orders.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      {debouncedQ ? `No orders match "${debouncedQ}".` : "No orders yet."}
                    </td>
                  </tr>
                )}
                {data?.orders.map((o) => (
                  <tr
                    key={o.id}
                    className="border-t border-border/40 hover:bg-muted/30 cursor-pointer"
                  >
                    <td className="py-3 px-4 font-mono text-xs">
                      <Link
                        href={`/admin/orders/${o.id}`}
                        className="text-primary hover:underline"
                        data-testid={`link-order-${o.orderReference}`}
                      >
                        {o.orderReference}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      {o.patientFirstName} {o.patientLastName}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">{o.patientEmail}</td>
                    <td className="py-3 px-4">
                      <span className="font-medium">{o.maskName}</span>
                      <span className="text-muted-foreground text-xs"> · {o.maskManufacturer}</span>
                    </td>
                    <td className="py-3 px-4">
                      {o.shippingCity}, {o.shippingState}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant={STATUS_TONE[o.emailStatus] ?? "outline"}>
                        {STATUS_LABEL[o.emailStatus] ?? o.emailStatus}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                      {new Date(o.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && (
            <div className="p-4 text-sm text-destructive border-t border-border/40">
              Could not load orders: {(error as Error).message}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
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
              data-testid="button-admin-prev"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              data-testid="button-admin-next"
            >
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
