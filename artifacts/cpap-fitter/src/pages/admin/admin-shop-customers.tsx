// /admin/shop/customers — paginated directory of registered shop
// customers, with search + sort + sub-filter.
//
// Companion to /admin/shop/customers/:userId (the detail page from
// PR #54). The directory makes the customer-360 surface navigable
// for CSRs who don't have a userId in hand — search by partial
// name or email, or jump from a row.
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
  type AdminCustomerListSortBy,
} from "@/lib/admin/customers-api";
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

/** Read a query-string param once for seeding initial state. */
function initialSearchParam(key: string): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(key) ?? "";
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
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1100,
        margin: "0 auto",
        display: "grid",
        gap: 16,
      }}
      data-testid="admin-customers-list-page"
    >
      <header style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Customers</h1>
        <p
          style={{
            margin: 0,
            color: "var(--text-muted, #475569)",
            fontSize: 13,
          }}
        >
          Registered shop accounts. Click a row to open the customer-360 profile
          (clinical info, in-app messages, orders).
        </p>
      </header>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          background: "var(--surface-1, #ffffff)",
          border: "1px solid var(--border, #e2e8f0)",
          borderRadius: 8,
          padding: 12,
        }}
      >
        <div style={{ flex: "1 1 220px", minWidth: 220 }}>
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name or email…"
            aria-label="Search customers by name or email"
            style={{
              width: "100%",
              height: 32,
              padding: "0 10px",
              border: "1px solid var(--border, #cbd5e1)",
              borderRadius: 6,
              fontSize: 13,
            }}
            data-testid="admin-customers-search"
          />
        </div>
        <SelectField
          label="Sort"
          value={sortBy}
          onChange={(v) => {
            setSortBy(v as AdminCustomerListSortBy);
            setPage(1);
          }}
          options={Object.entries(SORT_LABELS).map(([value, label]) => ({
            value,
            label,
          }))}
          testId="admin-customers-sort"
        />
        <SelectField
          label="Subscriptions"
          value={subFilter}
          onChange={(v) => {
            setSubFilter(v as "" | "active" | "none");
            setPage(1);
          }}
          options={[
            { value: "", label: "All" },
            { value: "active", label: "Active subs" },
            { value: "none", label: "No active subs" },
          ]}
          testId="admin-customers-sub-filter"
        />
        {/*
          Phase 9 — toggle to restrict the directory to customers
          whose in-app conversation is currently in awaiting_admin
          status. Cheap server-side filter (a partial-indexed JOIN
          to conversations).
        */}
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--text-muted, #475569)",
            cursor: "pointer",
          }}
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
          style={{
            marginLeft: "auto",
            fontSize: 12,
            color: "var(--text-muted, #475569)",
            fontVariantNumeric: "tabular-nums",
          }}
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

      {/* Body */}
      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : isPending ? (
        <SkeletonTable />
      ) : data.customers.length === 0 ? (
        <EmptyPanel hasFilter={!!trimmedQ || !!subFilter || awaitingOnly} />
      ) : (
        <div
          style={{
            background: "var(--surface-1, #ffffff)",
            border: "1px solid var(--border, #e2e8f0)",
            borderRadius: 8,
            overflowX: "auto",
            opacity: isFetching ? 0.7 : 1,
            transition: "opacity 120ms ease-out",
          }}
          data-testid="admin-customers-table-wrap"
        >
          <table
            style={{
              width: "100%",
              minWidth: 720,
              borderCollapse: "collapse",
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ background: "#f8fafc", textAlign: "left" }}>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th align="right">Orders</Th>
                <Th align="right">Lifetime</Th>
                <Th>Last order</Th>
                <Th>Subs</Th>
              </tr>
            </thead>
            <tbody>
              {data.customers.map((c) => (
                <tr
                  key={c.userId}
                  onClick={() =>
                    navigate(
                      `/admin/shop/customers/${encodeURIComponent(c.userId)}`,
                    )
                  }
                  style={{
                    cursor: "pointer",
                    borderTop: "1px solid var(--border, #e2e8f0)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#f8fafc";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "";
                  }}
                  data-testid={`admin-customers-row-${c.userId}`}
                >
                  <Td>
                    <div style={{ fontWeight: 600 }}>
                      {c.displayName ?? "Unnamed customer"}
                    </div>
                    <div
                      style={{
                        fontFamily: "monospace",
                        fontSize: 11,
                        color: "var(--text-muted, #475569)",
                      }}
                    >
                      {c.emailRedacted ?? "—"}
                    </div>
                  </Td>
                  <Td>
                    {c.inAppNeedsReply ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          background: "#fef3c7",
                          color: "#854d0e",
                          border: "1px solid #fcd34d",
                        }}
                        data-testid={`admin-customers-awaiting-${c.userId}`}
                        title="The customer's in-app conversation is awaiting a reply — a CSR owes them a response."
                      >
                        Awaiting reply
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted, #94a3b8)" }}>
                        —
                      </span>
                    )}
                  </Td>
                  <Td align="right">{c.ordersCount}</Td>
                  <Td align="right">
                    {formatMoneyCents(c.lifetimeValueCents)}
                  </Td>
                  <Td>{formatRelative(c.lastOrderAt, nowMs)}</Td>
                  <Td>
                    {c.hasActiveSubscription ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          background: "#dcfce7",
                          color: "#14532d",
                        }}
                      >
                        Active
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted, #475569)" }}>
                        —
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {data && data.total > PAGE_SIZE && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: "flex-end",
            fontSize: 13,
          }}
          data-testid="admin-customers-pagination"
        >
          <span style={{ color: "var(--text-muted, #475569)" }}>
            Page {page} of {totalPages}
          </span>
          <PageButton
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || isFetching}
            label="Previous"
          />
          <PageButton
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || isFetching}
            label="Next"
          />
        </div>
      )}
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────

function SelectField({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
  testId: string;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--text-muted, #475569)",
      }}
    >
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 28,
          padding: "0 8px",
          border: "1px solid var(--border, #cbd5e1)",
          borderRadius: 6,
          background: "white",
          fontSize: 13,
        }}
        data-testid={testId}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      style={{
        padding: "10px 14px",
        textAlign: align ?? "left",
        textTransform: "uppercase",
        fontSize: 11,
        letterSpacing: 0.5,
        color: "var(--text-muted, #475569)",
        fontWeight: 600,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      style={{
        padding: "10px 14px",
        textAlign: align ?? "left",
        verticalAlign: "top",
        fontVariantNumeric: align === "right" ? "tabular-nums" : "normal",
      }}
    >
      {children}
    </td>
  );
}

function PageButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 28,
        padding: "0 10px",
        border: "1px solid var(--border, #cbd5e1)",
        borderRadius: 6,
        background: disabled ? "#f1f5f9" : "white",
        color: disabled ? "#94a3b8" : "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 13,
      }}
    >
      {label}
    </button>
  );
}

function SkeletonTable() {
  return (
    <div
      style={{
        background: "var(--surface-1, #ffffff)",
        border: "1px solid var(--border, #e2e8f0)",
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
      role="status"
      aria-label="Loading customers"
      data-testid="admin-customers-loading"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 24,
            background:
              "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%)",
            backgroundSize: "200% 100%",
            animation: "admin-customers-skel 1.2s linear infinite",
            borderRadius: 4,
          }}
        />
      ))}
      <style>{`
        @keyframes admin-customers-skel {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}

function EmptyPanel({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div
      style={{
        background: "var(--surface-1, #ffffff)",
        border: "1px dashed var(--border, #cbd5e1)",
        borderRadius: 8,
        padding: 32,
        textAlign: "center",
        color: "var(--text-muted, #475569)",
      }}
      data-testid="admin-customers-empty"
    >
      <p style={{ margin: 0, fontWeight: 600, color: "inherit" }}>
        No customers match this view.
      </p>
      <p style={{ margin: "4px 0 0", fontSize: 13 }}>
        {hasFilter
          ? "Try clearing the search or subscription filter."
          : "Customer rows are created on first sign-in to /account."}
      </p>
    </div>
  );
}
