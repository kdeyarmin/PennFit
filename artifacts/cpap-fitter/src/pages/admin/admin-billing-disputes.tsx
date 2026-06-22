// /admin/billing/disputes — chargeback dispute worklist.
//
// Surfaces resupply.stripe_disputes (migration 0429), which the Stripe
// charge.dispute.* webhook upserts. Persisting disputes is pointless if an
// operator can't see the evidence deadline — this page is the missing UI for
// the backend that #1200 landed (GET /admin/billing/disputes). Open disputes
// first, ordered by evidence deadline, with the deadline highlighted when it's
// near. reports.read-gated server-side. No patient PHI — order + amount only.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gavel } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getBillingDisputes,
  type StripeDisputeRow,
} from "@/lib/admin/billing-disputes-api";

function usd(cents: number, currency: string): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
    maximumFractionDigits: 2,
  });
}

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.replace(/_/g, " ");
}

// Days until the evidence deadline; negative when already past.
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const due = new Date(iso).getTime();
  if (Number.isNaN(due)) return null;
  return Math.ceil((due - Date.now()) / 86_400_000);
}

export function AdminBillingDisputesPage() {
  const [status, setStatus] = useState<"open" | "all">("open");

  const query = useQuery({
    queryKey: ["admin", "billing", "disputes", status],
    queryFn: () => getBillingDisputes(status),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-billing-disputes-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Gavel className="h-6 w-6" />
            Chargeback disputes
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Card disputes opened against storefront charges, ordered by evidence
            deadline. Respond in the Stripe Dashboard before the deadline to
            contest the chargeback.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          Show
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "open" | "all")}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="open">Open only</option>
            <option value="all">All</option>
          </select>
        </label>
      </header>

      {query.isPending ? (
        <Spinner label="Loading disputes…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.disputes.length === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            {status === "open"
              ? "No open disputes. Chargebacks appear here the moment Stripe opens one."
              : "No disputes on record."}
          </p>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px]">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left">
                    Opened
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Reason
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Evidence due
                  </th>
                  <th scope="col" className="px-3 py-2 text-left">
                    Order
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.disputes.map((d) => (
                  <DisputeRow key={d.id} dispute={d} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function DisputeRow({ dispute }: { dispute: StripeDisputeRow }) {
  const isClosed = dispute.closedAt != null;
  const days = isClosed ? null : daysUntil(dispute.evidenceDueBy);
  // Highlight an approaching/past deadline on a still-open dispute.
  const deadlineUrgent = days != null && days <= 3;

  return (
    <tr className="border-t border-slate-100">
      <td
        className="px-3 py-2 text-xs tabular-nums"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {dispute.openedAt ? dispute.openedAt.slice(0, 10) : "—"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {usd(dispute.amountCents, dispute.currency)}
      </td>
      <td className="px-3 py-2 capitalize">{humanize(dispute.reason)}</td>
      <td className="px-3 py-2">
        <span className="capitalize">{humanize(dispute.status)}</span>
        {dispute.outcome ? (
          <span
            className="text-[11px] block"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {humanize(dispute.outcome)}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-xs">
        {isClosed ? (
          <span style={{ color: "hsl(var(--ink-3))" }}>closed</span>
        ) : dispute.evidenceDueBy ? (
          <span
            className={deadlineUrgent ? "font-semibold text-red-600" : ""}
            style={deadlineUrgent ? undefined : { color: "hsl(var(--ink-2))" }}
          >
            {dispute.evidenceDueBy.slice(0, 10)}
            {days != null
              ? ` (${days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`})`
              : ""}
          </span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
        )}
      </td>
      <td
        className="px-3 py-2 text-xs tabular-nums"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {dispute.orderId ? dispute.orderId.slice(0, 8) : "—"}
      </td>
    </tr>
  );
}
