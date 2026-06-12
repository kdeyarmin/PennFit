import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  Skeleton,
  Badge,
  Button,
} from "@/components/admin/ui-shims";
import { fetchAdminAnalytics } from "@/lib/admin/storefront-admin-api";
import { useDocumentTitle } from "@/hooks/admin/use-document-title";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  sent: "Delivered",
  failed: "Failed",
  skipped: "Skipped",
};
const STATUS_TONE: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  sent: "default",
  failed: "destructive",
  skipped: "secondary",
};

export function AdminAnalytics() {
  useDocumentTitle("Admin · Analytics");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["admin-analytics"],
    queryFn: fetchAdminAnalytics,
  });

  const peakDayCount =
    data && data.ordersByDay.length > 0
      ? Math.max(...data.ordersByDay.map((d) => d.count))
      : 0;

  return (
    <div className="space-y-5">
      <div>
        <h1
          className="text-display text-3xl font-bold tracking-tight"
          data-testid="admin-page-title"
        >
          Analytics
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          PennPaps storefront performance: total orders, email delivery health,
          most-ordered masks, fitter funnel completion, and a 30-day order
          trend.
        </p>
      </div>

      {error && (
        <Card className="border-destructive/40 glass-card rounded-2xl">
          <CardContent className="p-4 flex items-center justify-between gap-4">
            <p className="text-sm text-destructive">
              Could not load analytics: {(error as Error).message}
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              className="shrink-0"
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Total Orders
            </div>
            <div
              className="text-3xl font-semibold mt-2"
              data-testid="metric-total-orders"
            >
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                (data?.totalOrders ?? 0)
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Last 30 days
            </div>
            <div
              className="text-3xl font-semibold mt-2"
              data-testid="metric-orders-last-30d"
            >
              {isLoading ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                (data?.ordersByDay.reduce((sum, d) => sum + d.count, 0) ?? 0)
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-0 glass-card rounded-2xl">
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Peak day
            </div>
            <div
              className="text-3xl font-semibold mt-2"
              data-testid="metric-peak-day"
            >
              {isLoading ? <Skeleton className="h-8 w-16" /> : peakDayCount}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Email status breakdown */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-5">
          <h2 className="text-lg font-semibold mb-3">Order email status</h2>
          {isLoading && <Skeleton className="h-20 w-full" />}
          {!isLoading && data && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {data.statusBreakdown.map((row) => (
                <div
                  key={row.status}
                  className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
                  data-testid={`status-${row.status}`}
                >
                  <Badge variant={STATUS_TONE[row.status] ?? "outline"}>
                    {STATUS_LABEL[row.status] ?? row.status}
                  </Badge>
                  <span className="font-mono text-sm">{row.count}</span>
                </div>
              ))}
              {data.statusBreakdown.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No orders yet.
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top masks */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-5">
          <h2 className="text-lg font-semibold mb-3">
            Top masks (by order count)
          </h2>
          {isLoading && <Skeleton className="h-32 w-full" />}
          {!isLoading && data && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase tracking-wide">
                  <tr>
                    <th className="text-left py-2 px-3">Mask</th>
                    <th className="text-left py-2 px-3">Manufacturer</th>
                    <th className="text-right py-2 px-3">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topMasks.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="py-8 text-center text-muted-foreground"
                      >
                        No mask orders yet.
                      </td>
                    </tr>
                  )}
                  {data.topMasks.map((m, i) => (
                    <tr
                      key={`${m.maskName}-${i}`}
                      className="border-t border-border/40"
                      data-testid={`top-mask-${i}`}
                    >
                      <td className="py-2 px-3 font-medium">{m.maskName}</td>
                      <td className="py-2 px-3 text-muted-foreground">
                        {m.maskManufacturer}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        {m.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Fitter funnel */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-5">
          <h2 className="text-lg font-semibold mb-3">Fitter funnel</h2>
          <p className="text-xs text-muted-foreground mb-3">
            Counts of usage events captured at each step of the mask
            recommender. A large drop between steps points at a UX problem on
            the next page.
          </p>
          {isLoading && <Skeleton className="h-24 w-full" />}
          {!isLoading && data && (
            <div className="space-y-2">
              {data.funnel.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No usage events recorded yet.
                </div>
              )}
              {data.funnel.map((row) => {
                const max = Math.max(...data.funnel.map((f) => f.count), 1);
                const pct = Math.round((row.count / max) * 100);
                return (
                  <div key={row.step} data-testid={`funnel-${row.step}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">{row.step}</span>
                      <span className="font-mono text-muted-foreground">
                        {row.count}
                      </span>
                    </div>
                    <div className="h-2 bg-muted/40 rounded-full overflow-hidden mt-1">
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 30-day trend */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-5">
          <h2 className="text-lg font-semibold mb-3">Orders — last 30 days</h2>
          {isLoading && <Skeleton className="h-32 w-full" />}
          {!isLoading && data && (
            <>
              {data.ordersByDay.length === 0 && (
                <div className="text-sm text-muted-foreground">
                  No orders in the last 30 days.
                </div>
              )}
              {data.ordersByDay.length > 0 && (
                <div
                  className="flex items-end gap-1 h-32"
                  data-testid="trend-bars"
                >
                  {data.ordersByDay.map((d) => {
                    const pct =
                      peakDayCount > 0
                        ? Math.max(
                            4,
                            Math.round((d.count / peakDayCount) * 100),
                          )
                        : 4;
                    return (
                      <div
                        key={d.day}
                        title={`${d.day}: ${d.count}`}
                        className="flex-1 bg-primary/70 hover:bg-primary rounded-t-sm"
                        style={{ height: `${pct}%` }}
                        data-testid={`trend-day-${d.day}`}
                      />
                    );
                  })}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
