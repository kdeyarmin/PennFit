import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchAdminCustomers,
  AdminApiError,
  type AdminCustomerSortBy,
} from "@/lib/admin-api";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

const SORT_OPTIONS: ReadonlyArray<{
  value: AdminCustomerSortBy;
  label: string;
}> = [
  { value: "last_order", label: "Recent activity" },
  { value: "lifetime_value", label: "Lifetime value" },
  { value: "created_at", label: "Newest customers" },
];

const SUBSCRIPTION_OPTIONS = [
  { value: "any", label: "Any subscription" },
  { value: "active", label: "Has active sub" },
  { value: "none", label: "No active sub" },
] as const;

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AdminCustomers() {
  useDocumentTitle("Admin · Customers");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sortBy, setSortBy] = useState<AdminCustomerSortBy>("last_order");
  const [subscription, setSubscription] = useState<"any" | "active" | "none">(
    "any",
  );
  const [page, setPage] = useState(1);
  const pageSize = 25;

  // Debounce search input by 300ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to first page whenever filters change so we don't land on
  // an empty page (e.g. you were on page 4 of "all" and switched to
  // a query that only has 8 matches).
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, sortBy, subscription]);

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "admin-customers",
      { q: debouncedQ, sortBy, subscription, page, pageSize },
    ],
    queryFn: () =>
      fetchAdminCustomers({
        q: debouncedQ || undefined,
        sortBy,
        subscription: subscription === "any" ? undefined : subscription,
        page,
        pageSize,
      }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;

  const isAuthError =
    error instanceof AdminApiError && (error.status === 401 || error.status === 403);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-display text-3xl font-bold tracking-tight"
            data-testid="admin-page-title"
          >
            Customers
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Search any shop customer to see their full history and take action
            on their behalf.
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-4 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
              data-testid="input-customers-search"
            />
          </div>
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as AdminCustomerSortBy)}
          >
            <SelectTrigger
              className="w-full sm:w-52"
              data-testid="select-customers-sort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={subscription}
            onValueChange={(v) =>
              setSubscription(v as "any" | "active" | "none")
            }
          >
            <SelectTrigger
              className="w-full sm:w-48"
              data-testid="select-customers-sub"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBSCRIPTION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Auth-error banner: cross-API gate failed. The user is signed
          into cpap-fitter as an admin but their account doesn't have
          admin/agent role on the resupply-api side, so it rejects the
          request with 403. Surface a hint instead of a generic error. */}
      {isAuthError && (
        <Card className="border-destructive/40 bg-destructive/5 rounded-2xl">
          <CardContent className="p-4 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-destructive">
                Customer data access denied
              </div>
              <div className="text-muted-foreground mt-1">
                You're signed in as an admin here, but the shop service
                doesn't recognize your account. Ask an admin on the
                resupply dashboard to grant your account the admin (or
                agent) role from{" "}
                <code className="font-mono text-xs">/admin/team</code>{" "}
                and reload.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card className="border-0 glass-card rounded-2xl">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wide bg-muted/30">
                <tr>
                  <th className="text-left py-3 px-4">Customer</th>
                  <th className="text-left py-3 px-4">Email</th>
                  <th className="text-right py-3 px-4">Orders</th>
                  <th className="text-right py-3 px-4">Lifetime</th>
                  <th className="text-left py-3 px-4">Last order</th>
                  <th className="text-left py-3 px-4">Sub</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr
                      key={`skel-${i}`}
                      className="border-t border-border/40"
                    >
                      <td colSpan={7} className="py-3 px-4">
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))}
                {!isLoading && data && data.customers.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-12 text-center text-muted-foreground"
                    >
                      {debouncedQ
                        ? `No customers match "${debouncedQ}".`
                        : "No customers yet."}
                    </td>
                  </tr>
                )}
                {data?.customers.map((c) => (
                  <tr
                    key={c.userId}
                    className="border-t border-border/40 hover:bg-muted/30"
                    data-testid={`row-customer-${c.userId}`}
                  >
                    <td className="py-3 px-4">
                      <div className="font-medium">
                        {c.displayName ?? (
                          <span className="text-muted-foreground italic">
                            Unnamed
                          </span>
                        )}
                      </div>
                      {c.stripeCustomerId && (
                        <div className="text-muted-foreground font-mono text-xs">
                          {c.stripeCustomerId}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {c.emailRedacted ?? "—"}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {c.ordersCount}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">
                      {formatCents(c.lifetimeValueCents)}
                    </td>
                    <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">
                      {formatDate(c.lastOrderAt)}
                    </td>
                    <td className="py-3 px-4">
                      {c.hasActiveSubscription ? (
                        <Badge variant="default">Active</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          —
                        </Badge>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        data-testid={`button-view-customer-${c.userId}`}
                      >
                        <Link href={`/admin/customers/${c.userId}`}>
                          View <ExternalLink className="w-3.5 h-3.5 ml-1" />
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && !isAuthError && (
            <div className="p-4 text-sm text-destructive border-t border-border/40">
              Could not load customers: {(error as Error).message}
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
              data-testid="button-customers-prev"
            >
              <ChevronLeft className="w-4 h-4" /> Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              data-testid="button-customers-next"
            >
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
