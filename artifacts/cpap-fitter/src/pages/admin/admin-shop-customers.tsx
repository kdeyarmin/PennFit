// /admin/shop/customers — paginated directory of registered shop
// customers, with search + sort + sub-filter.
//
// Companion to /admin/shop/customers/:userId (the detail page from
// PR #54). The directory makes the customer-360 surface navigable
// for CSRs who don't have a userId in hand — search by partial
// name or email, or jump from a row.
//
// Built on the shared admin primitives (Card / Table / Badge / Input /
// Select / Pagination + admin-root tokens) so it matches the rest of
// the console rather than the bespoke gray inline-styled table it used
// to ship — see the patients list for the canonical pattern.
//
// PHI posture (mirrors the server endpoint):
//   * Email column shows the redacted form ("ja******@example.com")
//     — the directory never renders the full address. Click into
//     the detail page to see the full email.
//   * No browser-console logging of any row content.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import {
  listAdminCustomers,
  type AdminCustomerListInput,
  type AdminCustomerListRow,
  type AdminCustomerListSortBy,
} from "@/lib/admin/customers-api";
import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import { Badge } from "@/components/admin/Badge";
import { Input, Label, Select } from "@/components/admin/Input";
import { Pagination } from "@/components/admin/Pagination";
import { EmptyState } from "@/components/admin/EmptyState";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";

const PAGE_SIZE = 25;

function formatMoneyCents(cents: number): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatRelative(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const SORT_LABELS: Record<AdminCustomerListSortBy, string> = {
  last_order: "Last order",
  lifetime_value: "Lifetime value",
  created_at: "Account age",
};

const SORT_OPTIONS = Object.entries(SORT_LABELS).map(([value, label]) => ({
  value,
  label,
}));

const SUB_OPTIONS = [
  { value: "", label: "All" },
  { value: "active", label: "Active subs" },
  { value: "none", label: "No active subs" },
];

/** Read a query-string param once for seeding initial state. */
function initialSearchParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

function mutedDash() {
  return <span style={{ color: "hsl(var(--ink-3))" }}>—</span>;
}

export function AdminShopCustomersPage() {
  const [, navigate] = useLocation();
  // Seed the search box from `?search=` so a deep link (e.g. the
  // "Find this person in Customers" jump from a patient record) lands
  // pre-filtered. Search matches name or email server-side.
  const [q, setQ] = useState(() => initialSearchParam("search"));
  const [sortBy, setSortBy] = useState<AdminCustomerListSortBy>("last_order");
  const [subFilter, setSubFilter] = useState<"" | "active" | "none">("");
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const [page, setPage] = useState(1);

  // Trim + reset page whenever search/filter changes — without this,
  // a user on page 5 of "all customers" who types a query stays on
  // page 5 of the (much shorter) filtered set and sees an empty
  // table.
  const trimmedQ = q.trim();
  const input = useMemo<AdminCustomerListInput>(
    () => ({
      q: trimmedQ || undefined,
      page,
      pageSize: PAGE_SIZE,
      sortBy,
      order: "desc",
      subscription: subFilter || undefined,
      awaitingReply: awaitingOnly || undefined,
    }),
    [trimmedQ, page, sortBy, subFilter, awaitingOnly],
  );

  const { data, isPending, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["admin", "shop-customers", input],
    queryFn: () => listAdminCustomers(input),
    placeholderData: keepPreviousData,
  });

  const nowMs = Date.now();
  const hasFilter = !!trimmedQ || !!subFilter || awaitingOnly;

  const columns: Column<AdminCustomerListRow>[] = [
    {
      key: "customer",
      header: "Customer",
      render: (c) => (
        <div data-testid={`admin-customers-row-${c.userId}`}>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {c.displayName ?? "Unnamed customer"}
          </div>
          <div
            className="font-mono text-[11px]"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {c.emailRedacted ?? "—"}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (c) =>
        c.inAppNeedsReply ? (
          <span
            data-testid={`admin-customers-awaiting-${c.userId}`}
            title="The customer's in-app conversation is awaiting a reply — a CSR owes them a response."
          >
            <Badge variant="warning">Awaiting reply</Badge>
          </span>
        ) : (
          mutedDash()
        ),
    },
    {
      key: "orders",
      header: <span className="block text-right">Orders</span>,
      className: "text-right tabular-nums",
      render: (c) => c.ordersCount,
    },
    {
      key: "lifetime",
      header: <span className="block text-right">Lifetime</span>,
      className: "text-right tabular-nums",
      render: (c) => formatMoneyCents(c.lifetimeValueCents),
    },
    {
      key: "last_order",
      header: "Last order",
      render: (c) => formatRelative(c.lastOrderAt, nowMs),
    },
    {
      key: "subs",
      header: "Subs",
      render: (c) =>
        c.hasActiveSubscription ? (
          <Badge variant="success">Active</Badge>
        ) : (
          mutedDash()
        ),
    },
  ];

  return (
    <div
      className="space-y-6 max-w-6xl"
      data-testid="admin-customers-list-page"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Customers
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Registered shop accounts. Click a row to open the customer-360 profile
          (clinical info, in-app messages, orders).
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <Label htmlFor="admin-customers-search">Search</Label>
            <Input
              id="admin-customers-search"
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search by name or email…"
              data-testid="admin-customers-search"
            />
          </div>
          <div className="min-w-[150px]">
            <Label htmlFor="admin-customers-sort">Sort</Label>
            <Select
              id="admin-customers-sort"
              value={sortBy}
              options={SORT_OPTIONS}
              onChange={(e) => {
                setSortBy(e.target.value as AdminCustomerListSortBy);
                setPage(1);
              }}
              data-testid="admin-customers-sort"
            />
          </div>
          <div className="min-w-[150px]">
            <Label htmlFor="admin-customers-sub-filter">Subscriptions</Label>
            <Select
              id="admin-customers-sub-filter"
              value={subFilter}
              options={SUB_OPTIONS}
              onChange={(e) => {
                setSubFilter(e.target.value as "" | "active" | "none");
                setPage(1);
              }}
              data-testid="admin-customers-sub-filter"
            />
          </div>
          {/*
            Toggle to restrict the directory to customers whose in-app
            conversation is currently awaiting_admin. Cheap server-side
            filter (a partial-indexed JOIN to conversations).
          */}
          <label
            className="inline-flex items-center gap-2 text-sm pb-1.5 cursor-pointer"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            <input
              type="checkbox"
              checked={awaitingOnly}
              onChange={(e) => {
                setAwaitingOnly(e.target.checked);
                setPage(1);
              }}
              data-testid="admin-customers-awaiting-toggle"
            />
            Awaiting reply only
          </label>
          <span
            className="ml-auto pb-1.5 text-xs tabular-nums"
            style={{ color: "hsl(var(--ink-3))" }}
            aria-live="polite"
            data-testid="admin-customers-result-count"
          >
            {isPending
              ? "Loading…"
              : data
                ? `${data.total.toLocaleString()} customer${data.total === 1 ? "" : "s"}`
                : ""}
          </span>
        </div>
      </Card>

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <div
          className="surface-card flex items-center justify-center py-16"
          role="status"
          aria-label="Loading customers"
          data-testid="admin-customers-loading"
        >
          <Spinner />
        </div>
      ) : data.customers.length === 0 ? (
        <div className="surface-card" data-testid="admin-customers-empty">
          <EmptyState
            title="No customers match this view."
            hint={
              hasFilter
                ? "Try clearing the search or subscription filter."
                : "Customer rows are created on first sign-in to /account."
            }
          />
        </div>
      ) : (
        <div
          className="surface-card overflow-hidden"
          style={{
            opacity: isFetching ? 0.7 : 1,
            transition: "opacity 120ms ease-out",
          }}
          data-testid="admin-customers-table-wrap"
        >
          <Table
            columns={columns}
            rows={data.customers}
            rowKey={(c) => c.userId}
            onRowClick={(c) =>
              navigate(`/admin/shop/customers/${encodeURIComponent(c.userId)}`)
            }
          />
          {data.total > PAGE_SIZE && (
            <Pagination
              total={data.total}
              limit={PAGE_SIZE}
              offset={(page - 1) * PAGE_SIZE}
              onChange={(nextOffset) =>
                setPage(Math.floor(nextOffset / PAGE_SIZE) + 1)
              }
              isLoading={isFetching}
            />
          )}
        </div>
      )}
    </div>
  );
}
