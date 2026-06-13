import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

import {
  listReconciliations,
  startReconciliation,
  type ReconciliationListItem,
} from "@/lib/admin/inventory-reconciliation-api";
import { formatAppDate, todayAppDateIso } from "@/lib/utils";

// Inventory reconciliation list page.
//
// Two responsibilities on one screen:
//   1. List historical reconciliations (newest first) with status,
//      who started it, and the total variance the operator recorded.
//   2. A "Start new" form that opens a draft with a free-form period
//      label and optional notes, then redirects to the per-recon
//      edit page where counts are entered.
//
// Why one page (not two routes):
//   The history list is the natural home for the "Start new" CTA —
//   the operator typically lands here to either (a) review the
//   last reconciliation or (b) start the next one. Splitting would
//   force an extra click for the common case.

const QUERY_KEY = ["inventory-reconciliations"] as const;

function defaultPeriodLabel(): string {
  return todayAppDateIso().slice(0, 7);
}

function formatDate(iso: string): string {
  return formatAppDate(iso, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AdminShopInventoryReconcilePage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [periodLabel, setPeriodLabel] = useState(defaultPeriodLabel());
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const {
    data: items,
    isLoading,
    isError,
  } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listReconciliations,
    staleTime: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: () =>
      startReconciliation({
        periodLabel: periodLabel.trim(),
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setLocation(`/admin/shop/inventory/reconcile/${result.id}`);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to start");
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (periodLabel.trim().length < 2) {
      setError("Period label must be at least 2 characters.");
      return;
    }
    startMutation.mutate();
  }

  return (
    <div className="admin-root" style={{ maxWidth: 980 }}>
      <header style={{ marginBottom: 24 }}>
        <a
          href={`${import.meta.env.BASE_URL}admin/shop/inventory`}
          style={{
            color: "hsl(var(--ink-1))",
            fontSize: 13,
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 8,
          }}
        >
          ← Back to inventory
        </a>
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          Inventory reconciliation
        </h1>
        <p
          style={{
            margin: "8px 0 0",
            color: "hsl(var(--ink-2))",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Start a new reconciliation to enter physical counts SKU-by-SKU.
          Variance against the system count is recorded for the audit log; you
          can optionally push the new counts back to Stripe at submit time.
          Reconciliations are append-only after submission.
        </p>
      </header>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: 20,
          marginBottom: 24,
          background: "#ffffff",
        }}
      >
        <h2
          style={{
            margin: "0 0 12px",
            fontSize: 15,
            fontWeight: 600,
            color: "hsl(var(--ink-1))",
          }}
        >
          Start a new reconciliation
        </h2>
        <form onSubmit={onSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="periodLabel"
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "hsl(var(--ink-1))",
                marginBottom: 4,
              }}
            >
              Period label
            </label>
            <input
              id="periodLabel"
              type="text"
              value={periodLabel}
              onChange={(e) => setPeriodLabel(e.target.value)}
              data-testid="reconcile-period-input"
              disabled={startMutation.isPending}
              style={{
                width: 240,
                padding: "8px 10px",
                fontSize: 14,
                border: "1px solid #d1d5db",
                borderRadius: 6,
                fontFamily: "inherit",
              }}
            />
            <p
              style={{
                fontSize: 12,
                color: "hsl(var(--ink-3))",
                marginTop: 4,
              }}
            >
              Typically YYYY-MM. Defaults to the current month.
            </p>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="notes"
              style={{
                display: "block",
                fontSize: 13,
                fontWeight: 600,
                color: "hsl(var(--ink-1))",
                marginBottom: 4,
              }}
            >
              Notes (optional)
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="reconcile-notes-input"
              disabled={startMutation.isPending}
              placeholder="Context — e.g. 'after the May order', 'spot-check after relocation'"
              style={{
                width: "100%",
                maxWidth: 520,
                minHeight: 72,
                padding: "8px 10px",
                fontSize: 14,
                border: "1px solid #d1d5db",
                borderRadius: 6,
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
          </div>
          {error ? (
            <div
              role="alert"
              style={{
                color: "#b91c1c",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={startMutation.isPending}
            data-testid="reconcile-start-btn"
            style={{
              background: "#0a1f44",
              color: "#fff",
              border: "none",
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 600,
              borderRadius: 6,
              cursor: startMutation.isPending ? "wait" : "pointer",
            }}
          >
            {startMutation.isPending ? "Starting…" : "Start reconciliation"}
          </button>
        </form>
      </section>

      <h2
        style={{
          fontSize: 15,
          fontWeight: 600,
          color: "hsl(var(--ink-1))",
          margin: "0 0 12px",
        }}
      >
        History
      </h2>

      {isLoading ? (
        <div style={{ color: "hsl(var(--ink-3))" }}>Loading…</div>
      ) : isError ? (
        <div role="alert" style={{ color: "#b91c1c" }}>
          Failed to load history.
        </div>
      ) : !items || items.length === 0 ? (
        <div style={{ color: "hsl(var(--ink-3))" }}>
          No reconciliations yet — start your first one above.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              minWidth: 720,
              borderCollapse: "collapse",
              background: "#ffffff",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr style={{ background: "#f9fafb", textAlign: "left" }}>
                <Th>Period</Th>
                <Th>Status</Th>
                <Th>Started by</Th>
                <Th>Started</Th>
                <Th>Submitted</Th>
                <Th>Lines</Th>
                <Th>Variance</Th>
                <Th>Applied?</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <HistoryRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: "10px 12px",
        fontSize: 12,
        fontWeight: 600,
        color: "hsl(var(--ink-2))",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "10px 12px",
        fontSize: 13,
        color: "hsl(var(--ink-1))",
        verticalAlign: "top",
      }}
    >
      {children}
    </td>
  );
}

function HistoryRow({ row }: { row: ReconciliationListItem }) {
  return (
    <tr
      style={{
        borderTop: "1px solid #e5e7eb",
      }}
      data-testid={`reconcile-row-${row.id}`}
    >
      <Td>{row.periodLabel}</Td>
      <Td>
        <StatusBadge status={row.status} />
      </Td>
      <Td>{row.startedByEmail}</Td>
      <Td>{formatDate(row.startedAt)}</Td>
      <Td>{row.submittedAt ? formatDate(row.submittedAt) : "—"}</Td>
      <Td>{row.totalLines || "—"}</Td>
      <Td>{row.status === "submitted" ? row.totalVarianceUnits : "—"}</Td>
      <Td>{row.appliedToStripe ? "Yes" : "No"}</Td>
      <Td>
        <a
          href={`${import.meta.env.BASE_URL}admin/shop/inventory/reconcile/${row.id}`}
          style={{ color: "#0a1f44", fontWeight: 500, fontSize: 13 }}
        >
          {row.status === "draft" ? "Continue →" : "View →"}
        </a>
      </Td>
    </tr>
  );
}

function StatusBadge({ status }: { status: "draft" | "submitted" }) {
  if (status === "draft") {
    return (
      <span
        style={{
          background: "#fef3c7",
          color: "#92400e",
          padding: "2px 8px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        Draft
      </span>
    );
  }
  return (
    <span
      style={{
        background: "#dcfce7",
        color: "#166534",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      Submitted
    </span>
  );
}
