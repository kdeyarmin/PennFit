// /admin/shop/abandoned-carts — admin queue + dispatcher for the
// SendGrid cart-abandonment nudge.
//
// Page is intentionally small: a table of rows + a single
// "Send due reminders" action button at the top.
//
// Status derivation per row (mirrors the API/SQL suppression policy
// described in artifacts/resupply-api/src/routes/admin/abandoned-carts.ts):
//
//   recovered_at IS NOT NULL  → "Recovered"   (paid; never nudge)
//   cleared_at   IS NOT NULL  → "Cleared"     (user emptied; never nudge)
//   reminded_at  IS NOT NULL  → "Nudged"      (one-shot already sent)
//   age < 24h                 → "Cooling"     (waiting out the grace window)
//   else                      → "Eligible"    (next dispatcher run will pick up)
//
// Privacy: emails are already redacted server-side (head 2 chars +
// asterisks) so the rendered table never shows a usable contact list.
// We never log customerId to the page either — only the emailRedacted
// string is shown.
//
// Dispatcher: the "Send due reminders" button POSTs send-due, which
// is idempotent — clicking twice in quick succession only sends each
// row once. After it returns we invalidate the list query so the page
// re-renders with the rows that just flipped to "Nudged".

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type AbandonedCartRow,
  type SendDueResponse,
  listAdminAbandonedCarts,
  sendDueAbandonedCarts,
} from "../lib/abandoned-carts-api";
import { ErrorPanel } from "../components/ErrorPanel";

// Match the API constant — keep the two in sync if either changes.
const COOLING_MS = 24 * 60 * 60 * 1000;

type Status = "recovered" | "cleared" | "nudged" | "cooling" | "eligible";

function deriveStatus(row: AbandonedCartRow, nowMs: number): Status {
  if (row.recoveredAt) return "recovered";
  if (row.clearedAt) return "cleared";
  if (row.remindedAt) return "nudged";
  const ageMs = nowMs - new Date(row.updatedAt).getTime();
  return ageMs < COOLING_MS ? "cooling" : "eligible";
}

const STATUS_STYLE: Record<Status, { bg: string; fg: string; label: string }> = {
  recovered: { bg: "#dcfce7", fg: "#14532d", label: "Recovered" },
  cleared: { bg: "#f1f5f9", fg: "#475569", label: "Cleared" },
  nudged: { bg: "#dbeafe", fg: "#1e3a8a", label: "Nudged" },
  cooling: { bg: "#fef3c7", fg: "#854d0e", label: "Cooling 24h" },
  eligible: { bg: "#fee2e2", fg: "#7f1d1d", label: "Eligible" },
};

function formatMoneyCents(cents: number, currency: string): string {
  // Same lightweight formatter as the rest of the dashboard. Falls
  // back to a plain "$X.YY" string if Intl is unavailable.
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatRelative(iso: string, nowMs: number): string {
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

export function AdminShopAbandonedCartsPage() {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "shop-abandoned-carts"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listAdminAbandonedCarts,
  });

  const [lastResult, setLastResult] = useState<SendDueResponse | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const sendDue = useMutation({
    mutationFn: sendDueAbandonedCarts,
    onSuccess: (res) => {
      setLastResult(res);
      setOpError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      setOpError(err instanceof Error ? err.message : String(err));
      setLastResult(null);
    },
  });

  const nowMs = Date.now();
  const rows = data?.rows ?? [];

  // Counts for the small KPI strip above the table — gives the admin
  // a one-glance answer to "is there anything for me to do?" before
  // they scan the rows.
  const counts = rows.reduce<Record<Status, number>>(
    (acc, r) => {
      const s = deriveStatus(r, nowMs);
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    { recovered: 0, cleared: 0, nudged: 0, cooling: 0, eligible: 0 },
  );

  return (
    <div
      className="space-y-6"
      data-testid="admin-shop-abandoned-carts-page"
    >
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Abandoned shop carts
        </h1>
        <p className="text-sm text-slate-600 max-w-2xl">
          Customers whose cart sat for 24+ hours without checkout. Use{" "}
          <span className="font-semibold">Send due reminders</span> to
          dispatch one nudge email per eligible row — already-nudged,
          recovered, and cleared rows are skipped automatically.
        </p>
      </header>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3"
        data-testid="abandoned-counts"
      >
        {(
          ["eligible", "cooling", "nudged", "recovered", "cleared"] as Status[]
        ).map((s) => {
          const sty = STATUS_STYLE[s];
          return (
            <div
              key={s}
              className="border rounded-lg p-3 bg-white"
              style={{ borderColor: "hsl(var(--line-1))" }}
              data-testid={`abandoned-count-${s}`}
            >
              <div
                className="text-[10px] font-bold uppercase tracking-wider mb-1"
                style={{ color: sty.fg }}
              >
                {sty.label}
              </div>
              <div
                className="text-2xl font-semibold tabular-nums"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {counts[s]}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => sendDue.mutate()}
          disabled={sendDue.isPending || counts.eligible === 0}
          className="px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            backgroundColor: "#0a1f44",
            color: "#ffffff",
            border: "1px solid #c9a24a",
          }}
          data-testid="abandoned-send-due-btn"
        >
          {sendDue.isPending
            ? "Sending…"
            : counts.eligible === 0
              ? "No eligible carts"
              : `Send due reminders (${counts.eligible})`}
        </button>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isPending}
          className="px-3 py-2 rounded text-xs font-semibold border bg-white"
          style={{ color: "hsl(var(--ink-1))", borderColor: "hsl(var(--line-1))" }}
          data-testid="abandoned-refresh-btn"
        >
          Refresh
        </button>
        {lastResult && (
          <span
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{
              backgroundColor: "#ecfdf5",
              color: "#065f46",
              border: "1px solid #a7f3d0",
            }}
            data-testid="abandoned-send-due-result"
          >
            Scanned {lastResult.scanned} · sent {lastResult.sent}
            {lastResult.skippedFailed > 0 &&
              ` · failed ${lastResult.skippedFailed}`}
            {!lastResult.sendgridConfigured &&
              " · SendGrid not configured"}
          </span>
        )}
        {opError && (
          <span
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{
              backgroundColor: "#fef2f2",
              color: "#991b1b",
              border: "1px solid #fecaca",
            }}
            data-testid="abandoned-send-due-error"
          >
            {opError}
          </span>
        )}
      </div>

      {isError && (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      )}

      <div
        className="border rounded-lg bg-white overflow-hidden"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "#f8fafc" }}>
            <tr style={{ color: "#475569" }}>
              <th className="text-left px-3 py-2 font-semibold">Status</th>
              <th className="text-left px-3 py-2 font-semibold">Customer</th>
              <th className="text-right px-3 py-2 font-semibold">Items</th>
              <th className="text-right px-3 py-2 font-semibold">Subtotal</th>
              <th className="text-left px-3 py-2 font-semibold">
                Updated
              </th>
              <th className="text-left px-3 py-2 font-semibold">Nudge</th>
            </tr>
          </thead>
          <tbody>
            {isPending && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-slate-500"
                  data-testid="abandoned-loading"
                >
                  Loading…
                </td>
              </tr>
            )}
            {!isPending && rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-slate-500"
                  data-testid="abandoned-empty"
                >
                  No abandoned carts. The cart-abandonment table only
                  records signed-in users with at least one item that
                  sat untouched for the cooling window.
                </td>
              </tr>
            )}
            {!isPending &&
              rows.map((r) => {
                const status = deriveStatus(r, nowMs);
                const sty = STATUS_STYLE[status];
                return (
                  <tr
                    key={r.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                    data-testid={`abandoned-row-${r.id}`}
                  >
                    <td className="px-3 py-2 align-top">
                      <span
                        className="inline-block text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded"
                        style={{
                          backgroundColor: sty.bg,
                          color: sty.fg,
                        }}
                      >
                        {sty.label}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 align-top font-mono text-xs"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {r.emailRedacted ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums align-top">
                      {r.itemCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums align-top">
                      {formatMoneyCents(r.subtotalCents, r.currency)}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-600">
                      <span title={new Date(r.updatedAt).toLocaleString()}>
                        {formatRelative(r.updatedAt, nowMs)}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-slate-600">
                      {r.remindedAt ? (
                        <span
                          title={new Date(r.remindedAt).toLocaleString()}
                        >
                          {formatRelative(r.remindedAt, nowMs)}
                        </span>
                      ) : status === "cooling" ? (
                        <span className="text-xs text-slate-400">
                          waiting
                        </span>
                      ) : status === "eligible" ? (
                        <span className="text-xs text-slate-400">
                          ready
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
