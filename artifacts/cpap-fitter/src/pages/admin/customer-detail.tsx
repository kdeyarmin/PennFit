import { useState } from "react";
import { Link, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AdminApiError,
  fetchAdminCustomer,
  reorderForCustomer,
  type AdminCustomerDetail,
  type AdminCustomerOrderRow,
  type AdminCustomerReorderResponse,
} from "@/lib/admin-api";
import {
  ArrowLeft,
  AlertCircle,
  ShieldAlert,
  Copy,
  ExternalLink,
  RotateCcw,
  Mail,
  CreditCard,
  CalendarClock,
  Package,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

const ORDER_STATUS_TONE: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  paid: "default",
  pending: "outline",
  fulfilled: "default",
  shipped: "default",
  delivered: "default",
  refunded: "destructive",
  failed: "destructive",
  canceled: "secondary",
};

const SUB_STATUS_TONE: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  active: "default",
  trialing: "default",
  past_due: "destructive",
  canceled: "secondary",
  incomplete: "outline",
  incomplete_expired: "secondary",
  unpaid: "destructive",
};

const REVIEW_STATUS_TONE: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  approved: "default",
  pending: "outline",
  rejected: "destructive",
};

function fmtCents(
  cents: number | null | undefined,
  currency: string | null = "USD",
): string {
  // Pending orders carry amount_total_cents=null until Stripe confirms
  // the price. Render an em dash instead of a misleading $0.00.
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency?.toUpperCase() || "USD",
  }).format(cents / 100);
}

function fmtDate(iso: string | null, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return withTime
    ? d.toLocaleString()
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function shortOrderRef(id: string): string {
  // No formal order_reference column for shop orders — surface the
  // first 8 chars of the UUID prefix as a stable short code so the
  // admin can read it aloud on a phone call.
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function AdminCustomerDetailPage() {
  const params = useParams<{ userId: string }>();
  const userId = params.userId ?? "";
  useDocumentTitle("Admin · Customer");

  const { data, isLoading, error } = useQuery<AdminCustomerDetail>({
    queryKey: ["admin-customer", userId],
    queryFn: () => fetchAdminCustomer(userId),
    enabled: !!userId,
  });

  const isAuthError =
    error instanceof AdminApiError &&
    (error.status === 401 || error.status === 403);
  const isNotFound = error instanceof AdminApiError && error.status === 404;

  return (
    <div className="space-y-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
          <Link href="/admin/customers" data-testid="link-back-customers">
            <ArrowLeft className="w-4 h-4 mr-1" /> All customers
          </Link>
        </Button>
      </div>

      {isAuthError && (
        <Alert variant="destructive" className="border-destructive/40">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Customer data access denied</AlertTitle>
          <AlertDescription>
            Your email isn't on the shop service's admin allowlist. Add it to
            <code className="font-mono text-xs mx-1">
              RESUPPLY_ADMIN_EMAILS
            </code>
            and reload.
          </AlertDescription>
        </Alert>
      )}

      {isNotFound && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Customer not found</AlertTitle>
          <AlertDescription>
            We couldn't find a customer with that id. They may have only ever
            interacted with our public shop catalog.
          </AlertDescription>
        </Alert>
      )}

      {error && !isAuthError && !isNotFound && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Could not load customer</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      {isLoading && <CustomerSkeleton />}
      {data && <CustomerView userId={userId} detail={data} />}
    </div>
  );
}

function CustomerSkeleton() {
  return (
    <>
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-4 w-64" />
        </CardContent>
      </Card>
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </CardContent>
      </Card>
    </>
  );
}

function CustomerView({
  userId,
  detail,
}: {
  userId: string;
  detail: AdminCustomerDetail;
}) {
  const { customer, orders, subscriptions, abandonedCart, reviews, stats } =
    detail;

  return (
    <>
      {/* Header */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className="text-display text-2xl font-bold tracking-tight"
                data-testid="customer-display-name"
              >
                {customer.displayName ?? (
                  <span className="text-muted-foreground italic">
                    Unnamed customer
                  </span>
                )}
              </h1>
              {customer.isGuest && (
                <Badge variant="outline" className="text-muted-foreground">
                  Guest checkout only
                </Badge>
              )}
            </div>
            <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
              {customer.email ? (
                <a
                  href={`mailto:${customer.email}`}
                  className="hover:text-foreground inline-flex items-center gap-1"
                  data-testid="customer-email"
                >
                  <Mail className="w-3.5 h-3.5" /> {customer.email}
                </a>
              ) : (
                <span className="italic">No email on file</span>
              )}
              {customer.stripeCustomerId && (
                <span className="font-mono text-xs">
                  · {customer.stripeCustomerId}
                </span>
              )}
            </div>
            <div className="text-sm text-muted-foreground">
              Customer since {fmtDate(customer.createdAt)}
            </div>
          </div>
          {customer.defaultPaymentMethod && (
            <div className="text-right">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">
                Default card
              </div>
              <div className="font-medium inline-flex items-center gap-1.5 mt-0.5">
                <CreditCard className="w-4 h-4" />
                <span className="capitalize">
                  {customer.defaultPaymentMethod.brand ?? "card"}
                </span>{" "}
                ····{" "}
                {customer.defaultPaymentMethod.last4 ?? "····"}
              </div>
              {customer.defaultPaymentMethod.expMonth &&
                customer.defaultPaymentMethod.expYear && (
                  <div className="text-xs text-muted-foreground">
                    Exp{" "}
                    {String(customer.defaultPaymentMethod.expMonth).padStart(
                      2,
                      "0",
                    )}
                    /{customer.defaultPaymentMethod.expYear}
                  </div>
                )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="Orders" value={String(stats.ordersCount)} />
        <StatCard label="Lifetime" value={fmtCents(stats.lifetimeValueCents)} />
        <StatCard label="Avg order" value={fmtCents(stats.avgOrderValueCents)} />
        <StatCard label="Last order" value={fmtDate(stats.lastOrderAt)} />
        <StatCard
          label="Active subs"
          value={String(
            subscriptions.filter((s) => s.status === "active").length,
          )}
        />
      </div>

      {/* Orders */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <Package className="w-4 h-4" /> Recent orders
            <span className="text-muted-foreground font-normal text-sm">
              ({orders.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              No orders yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                  <tr>
                    <th className="text-left py-2 px-4">Ref</th>
                    <th className="text-left py-2 px-4">Date</th>
                    <th className="text-right py-2 px-4">Total</th>
                    <th className="text-right py-2 px-4">Items</th>
                    <th className="text-left py-2 px-4">Status</th>
                    <th className="py-2 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <OrderRow key={o.id} order={o} userId={userId} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Subscriptions */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarClock className="w-4 h-4" /> Subscriptions
            <span className="text-muted-foreground font-normal text-sm">
              ({subscriptions.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {subscriptions.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              No subscriptions on file.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                  <tr>
                    <th className="text-left py-2 px-4">Sub id</th>
                    <th className="text-left py-2 px-4">Status</th>
                    <th className="text-left py-2 px-4">Renews</th>
                    <th className="text-left py-2 px-4">Started</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-t border-border/40"
                      data-testid={`row-sub-${s.id}`}
                    >
                      <td className="py-2 px-4 font-mono text-xs">
                        {s.stripeSubscriptionId ?? s.id.slice(0, 12)}
                      </td>
                      <td className="py-2 px-4">
                        <Badge variant={SUB_STATUS_TONE[s.status] ?? "outline"}>
                          {s.status}
                        </Badge>
                        {s.cancelAtPeriodEnd && (
                          <span className="text-muted-foreground text-xs ml-2">
                            cancels at period end
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-4 text-muted-foreground">
                        {fmtDate(s.currentPeriodEnd)}
                      </td>
                      <td className="py-2 px-4 text-muted-foreground">
                        {fmtDate(s.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Abandoned cart */}
      {abandonedCart && (
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Abandoned cart</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-3 items-center">
              <span className="font-medium">
                {fmtCents(abandonedCart.subtotalCents, abandonedCart.currency)}
              </span>
              <span className="text-muted-foreground">
                {Array.isArray(abandonedCart.items)
                  ? `${abandonedCart.items.length} items`
                  : ""}
              </span>
              {abandonedCart.recoveredAt ? (
                <Badge variant="default">Recovered</Badge>
              ) : abandonedCart.clearedAt ? (
                <Badge variant="secondary">Cleared</Badge>
              ) : abandonedCart.remindedAt ? (
                <Badge variant="outline">Reminded</Badge>
              ) : (
                <Badge variant="outline">Open</Badge>
              )}
            </div>
            <div className="text-muted-foreground text-xs">
              Created {fmtDate(abandonedCart.createdAt, true)}
              {abandonedCart.remindedAt &&
                ` · last reminder ${fmtDate(abandonedCart.remindedAt, true)}`}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Reviews */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">
            Reviews
            <span className="text-muted-foreground font-normal text-sm ml-2">
              ({reviews.length})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {reviews.length === 0 ? (
            <div className="px-6 pb-6 text-sm text-muted-foreground">
              No reviews submitted.
            </div>
          ) : (
            <ul className="divide-y divide-border/40">
              {reviews.map((r) => (
                <li key={r.id} className="px-6 py-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{"★".repeat(r.rating)}</span>
                    <Badge variant={REVIEW_STATUS_TONE[r.status] ?? "outline"}>
                      {r.status}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                      {fmtDate(r.createdAt)}
                    </span>
                  </div>
                  {r.title && (
                    <div className="font-medium mt-1">{r.title}</div>
                  )}
                  {r.body && (
                    <div className="text-muted-foreground mt-0.5">{r.body}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-0 glass-card rounded-2xl">
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wide">
          {label}
        </div>
        <div
          className="text-xl font-semibold mt-1 tabular-nums"
          data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------
// Reorder flow
// ---------------------------------------------------------------------
//
// Two-step UX so the admin can't accidentally generate a Stripe URL
// (which costs nothing locally but does create a Checkout Session
// that takes up admin headspace if they're firing them off):
//   1. Click "Reorder" on a paid order → confirm dialog with item
//      count + total reminder.
//   2. Confirm → POST → dialog content swaps to the generated URL
//      with Copy + Open buttons.

function OrderRow({
  order: o,
  userId,
}: {
  order: AdminCustomerOrderRow;
  userId: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<AdminCustomerReorderResponse | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      reorderForCustomer({ userId, sourceOrderId: o.id }),
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["admin-customer", userId] });
    },
  });

  const isPaid = !!o.paidAt && o.status !== "refunded";

  function copyUrl() {
    if (!result?.checkoutUrl) return;
    navigator.clipboard.writeText(result.checkoutUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Reset on close so re-opening starts fresh.
      setResult(null);
      setCopied(false);
      mutation.reset();
    }
  }

  return (
    <tr className="border-t border-border/40" data-testid={`row-order-${o.id}`}>
      <td className="py-2 px-4 font-mono text-xs">{shortOrderRef(o.id)}</td>
      <td className="py-2 px-4 text-muted-foreground whitespace-nowrap">
        {fmtDate(o.createdAt)}
      </td>
      <td className="py-2 px-4 text-right tabular-nums">
        {fmtCents(o.amountTotalCents, o.currency)}
      </td>
      <td className="py-2 px-4 text-right tabular-nums">{o.itemCount}</td>
      <td className="py-2 px-4">
        <Badge variant={ORDER_STATUS_TONE[o.status] ?? "outline"}>
          {o.status}
        </Badge>
      </td>
      <td className="py-2 px-4 text-right">
        {isPaid && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
              data-testid={`button-reorder-${o.id}`}
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reorder
            </Button>
            <Dialog open={open} onOpenChange={handleOpenChange}>
              <DialogContent>
                {!result ? (
                  <>
                    <DialogHeader>
                      <DialogTitle>Reorder these items?</DialogTitle>
                      <DialogDescription>
                        We'll create a fresh Stripe Checkout link prefilled with
                        the {o.itemCount} item{o.itemCount === 1 ? "" : "s"}{" "}
                        from this {fmtCents(o.amountTotalCents, o.currency)}{" "}
                        order. The customer pays through it themselves — no card
                        is charged here.
                      </DialogDescription>
                    </DialogHeader>
                    {mutation.isError && (
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                          {(mutation.error as Error).message}
                        </AlertDescription>
                      </Alert>
                    )}
                    <DialogFooter>
                      <Button
                        variant="outline"
                        onClick={() => handleOpenChange(false)}
                        disabled={mutation.isPending}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={() => mutation.mutate()}
                        disabled={mutation.isPending}
                        data-testid={`button-reorder-confirm-${o.id}`}
                      >
                        {mutation.isPending ? "Generating…" : "Generate link"}
                      </Button>
                    </DialogFooter>
                  </>
                ) : (
                  <>
                    <DialogHeader>
                      <DialogTitle>Checkout link ready</DialogTitle>
                      <DialogDescription>
                        Send this URL to the customer. It expires after 24
                        hours.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs break-all">
                      {result.checkoutUrl}
                    </div>
                    {result.expiresAt && (
                      <div className="text-xs text-muted-foreground">
                        Expires {fmtDate(result.expiresAt, true)}
                      </div>
                    )}
                    <DialogFooter className="gap-2">
                      <Button variant="outline" onClick={copyUrl}>
                        <Copy className="w-3.5 h-3.5 mr-1" />
                        {copied ? "Copied!" : "Copy URL"}
                      </Button>
                      <Button asChild>
                        <a
                          href={result.checkoutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open <ExternalLink className="w-3.5 h-3.5 ml-1" />
                        </a>
                      </Button>
                    </DialogFooter>
                  </>
                )}
              </DialogContent>
            </Dialog>
          </>
        )}
      </td>
    </tr>
  );
}
