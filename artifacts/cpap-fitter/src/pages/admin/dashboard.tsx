import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchAdminAnalytics, fetchAdminOrders } from "@/lib/admin-api";
import { funnelStepLabel } from "@/lib/admin-labels";
import { Package, CheckCircle2, AlertCircle, TrendingUp, ArrowRight } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending send",
  sent: "Delivered",
  failed: "Failed",
  skipped: "Skipped (no email config)",
};
const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  sent: "default",
  failed: "destructive",
  skipped: "secondary",
};

export function AdminDashboard() {
  useDocumentTitle("Admin · Dashboard");
  const analytics = useQuery({ queryKey: ["admin-analytics"], queryFn: fetchAdminAnalytics });
  const recentOrders = useQuery({
    queryKey: ["admin-orders", { page: 1, pageSize: 8 }],
    queryFn: () => fetchAdminOrders({ page: 1, pageSize: 8 }),
  });

  const data = analytics.data;
  const totalsBy = (status: string) =>
    data?.statusBreakdown.find((s) => s.status === status)?.count ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-display text-3xl font-bold tracking-tight" data-testid="admin-page-title">
          Dashboard
        </h1>
        <p className="text-muted-foreground mt-1">
          A daily snapshot of orders coming in and how shoppers are using the
          mask-fit tool. Use the menu on the left to dig into specific orders or
          reminders.
        </p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Total orders"
          value={analytics.isLoading ? null : data?.totalOrders ?? 0}
          icon={<Package className="w-5 h-5" />}
        />
        <StatCard
          title="Delivered to PennPaps"
          value={analytics.isLoading ? null : totalsBy("sent")}
          icon={<CheckCircle2 className="w-5 h-5" />}
          tone="success"
        />
        <StatCard
          title="Failed delivery"
          value={analytics.isLoading ? null : totalsBy("failed")}
          icon={<AlertCircle className="w-5 h-5" />}
          tone={totalsBy("failed") > 0 ? "danger" : "default"}
        />
        <StatCard
          title="Successful orders (last 30 days)"
          value={
            analytics.isLoading
              ? null
              : data?.funnel.find((f) => f.step === "order_submitted_success")?.count ?? 0
          }
          icon={<TrendingUp className="w-5 h-5" />}
        />
      </div>

      {/* Top masks + funnel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">Most-ordered masks</CardTitle>
            <CardDescription>
              The masks customers picked the most. Counts include every order,
              not just delivered ones.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {analytics.isLoading && (
              <>
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
              </>
            )}
            {!analytics.isLoading && (data?.topMasks?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">No orders yet.</p>
            )}
            {data?.topMasks.map((m) => (
              <div
                key={`${m.maskManufacturer}-${m.maskName}`}
                className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-b-0"
              >
                <div className="text-sm">
                  <span className="font-medium">{m.maskName}</span>
                  <span className="text-muted-foreground"> · {m.maskManufacturer}</span>
                </div>
                <Badge variant="secondary">{m.count}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <CardTitle className="text-lg">Customer journey</CardTitle>
            <CardDescription>
              How far anonymous shoppers get through the mask-fit flow before
              they place an order. Higher numbers near the bottom mean more
              people are completing the full journey.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {analytics.isLoading && (
              <>
                <Skeleton className="h-7 w-full" />
                <Skeleton className="h-7 w-full" />
              </>
            )}
            {!analytics.isLoading && (data?.funnel?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing recorded yet. Once shoppers start using the mask-fit
                tool, their progress will show here.
              </p>
            )}
            {data?.funnel.map((f) => (
              <div
                key={f.step}
                className="flex items-center justify-between py-1.5 border-b border-border/40 last:border-b-0"
              >
                <span className="text-sm text-foreground">
                  {funnelStepLabel(f.step)}
                </span>
                <Badge variant="outline">{f.count}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Recent orders */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-lg">Recent orders</CardTitle>
          <Link href="/admin/orders">
            <Button variant="ghost" size="sm" className="gap-1">
              View all <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          {recentOrders.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (recentOrders.data?.orders?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No orders yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase tracking-wide">
                  <tr className="border-b border-border/50">
                    <th className="text-left py-2 px-2">Reference</th>
                    <th className="text-left py-2 px-2">Patient</th>
                    <th className="text-left py-2 px-2">Mask</th>
                    <th className="text-left py-2 px-2">Status</th>
                    <th className="text-left py-2 px-2">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {recentOrders.data?.orders.map((o) => (
                    <tr key={o.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-2 px-2 font-mono text-xs">
                        <Link href={`/admin/orders/${o.id}`} className="text-primary hover:underline">
                          {o.orderReference}
                        </Link>
                      </td>
                      <td className="py-2 px-2">
                        {o.patientFirstName} {o.patientLastName}
                      </td>
                      <td className="py-2 px-2">{o.maskName}</td>
                      <td className="py-2 px-2">
                        <Badge variant={STATUS_TONE[o.emailStatus] ?? "outline"}>
                          {STATUS_LABEL[o.emailStatus] ?? o.emailStatus}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">
                        {new Date(o.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  title,
  value,
  icon,
  tone = "default",
}: {
  title: string;
  value: number | null;
  icon: React.ReactNode;
  tone?: "default" | "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground";
  return (
    <Card className="border-0 glass-card rounded-2xl">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
            <div className={`text-3xl font-semibold mt-1 ${toneClass}`}>
              {value === null ? <Skeleton className="h-9 w-14" /> : value.toLocaleString()}
            </div>
          </div>
          <div className="text-muted-foreground">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}
