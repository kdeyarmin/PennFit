// /admin/billing/timely-filing — open-claim filing-deadline worklist
// (Biller #36).
//
// Every payer auto-denies a claim filed past its timely-filing window.
// This ranks every still-open claim most-urgent-first so the biller
// files the at-risk ones before they age out. The countdown is computed
// server-side (shared, tested domain helper); this page just renders the
// ranked rows + the status buckets.
//
// reports.read-gated server-side; the nav entry is shown to the billing
// team. Claim metadata only — no PHI beyond the existing claim list.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import {
  listTimelyFiling,
  type TimelyFilingClaim,
  type TimelyFilingFilter,
  type TimelyFilingStatus,
} from "@/lib/admin/billing-timely-filing-api";

const FILTERS: ReadonlyArray<{ value: TimelyFilingFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "due_soon", label: "Due soon" },
  { value: "ok", label: "On track" },
  { value: "unknown", label: "No window" },
];

const FILING_VARIANT: Record<
  TimelyFilingStatus,
  "success" | "warning" | "danger" | "muted"
> = {
  ok: "success",
  due_soon: "warning",
  overdue: "danger",
  unknown: "muted",
};

const FILING_LABEL: Record<TimelyFilingStatus, string> = {
  ok: "On track",
  due_soon: "Due soon",
  overdue: "Overdue",
  unknown: "No window",
};

function formatMoney(cents: number | null): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function daysLabel(days: number | null): string {
  if (days == null) return "—";
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "due today";
  return `${days}d left`;
}

export function AdminBillingTimelyFilingPage() {
  const [filter, setFilter] = useState<TimelyFilingFilter>("all");

  const query = useQuery({
    queryKey: ["admin", "billing", "timely-filing", filter] as const,
    queryFn: () => listTimelyFiling(filter),
    refetchInterval: 120_000,
  });

  const counts = query.data?.counts;

  return (
    <div
      className="p-6 space-y-6 max-w-6xl"
      data-testid="admin-billing-timely-filing-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <CalendarClock className="h-6 w-6" />
          Filing deadlines
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Open claims ranked by how close they are to the payer&apos;s
          timely-filing deadline (date of service + the payer&apos;s filing
          window). File the overdue and due-soon ones before they auto-deny.
        </p>
      </header>

      {counts && (
        <div className="flex flex-wrap gap-2">
          <CountChip label="Overdue" value={counts.overdue} variant="danger" />
          <CountChip
            label="Due soon"
            value={counts.dueSoon}
            variant="warning"
          />
          <CountChip label="On track" value={counts.ok} variant="success" />
          <CountChip label="No window" value={counts.unknown} variant="muted" />
        </div>
      )}

      <div
        role="tablist"
        aria-label="Filter by filing status"
        className="inline-flex gap-1 p-1 rounded-lg bg-slate-100"
      >
        {FILTERS.map((f) => {
          const active = f.value === filter;
          return (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                active
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : query.isError ? (
        <div className="text-sm text-rose-700" role="alert">
          Couldn&apos;t load the worklist:{" "}
          {query.error instanceof Error ? query.error.message : "unknown"}.
        </div>
      ) : query.data.claims.length === 0 ? (
        <div
          className="text-sm text-slate-500"
          data-testid="timely-filing-empty"
        >
          No open claims{filter === "all" ? "" : ` in this bucket`}.
        </div>
      ) : (
        <ClaimsTable claims={query.data.claims} />
      )}
    </div>
  );
}

function CountChip({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "success" | "warning" | "danger" | "muted";
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Badge variant={variant}>{value}</Badge>
      <span className="text-slate-600">{label}</span>
    </span>
  );
}

function ClaimsTable({ claims }: { claims: TimelyFilingClaim[] }) {
  const rows = useMemo(() => claims, [claims]);
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[820px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Filing</th>
            <th className="text-left px-3 py-2">Days</th>
            <th className="text-left px-3 py-2">Deadline</th>
            <th className="text-left px-3 py-2">Payer</th>
            <th className="text-left px-3 py-2">DOS</th>
            <th className="text-left px-3 py-2">Claim status</th>
            <th className="text-right px-3 py-2">Billed</th>
            <th className="text-left px-3 py-2">Patient</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <ClaimRow key={c.id} claim={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClaimRow({ claim }: { claim: TimelyFilingClaim }) {
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="px-3 py-2">
        <Badge variant={FILING_VARIANT[claim.filingStatus]}>
          {FILING_LABEL[claim.filingStatus]}
        </Badge>
      </td>
      <td
        className={`px-3 py-2 text-xs tabular-nums whitespace-nowrap ${
          claim.filingStatus === "overdue"
            ? "text-rose-700 font-semibold"
            : claim.filingStatus === "due_soon"
              ? "text-amber-700 font-semibold"
              : "text-slate-600"
        }`}
      >
        {daysLabel(claim.daysRemaining)}
      </td>
      <td className="px-3 py-2 text-xs text-slate-700 tabular-nums whitespace-nowrap">
        {claim.deadline ?? "—"}
      </td>
      <td className="px-3 py-2 text-sm text-slate-800">
        {claim.payerName ?? <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-slate-600 tabular-nums whitespace-nowrap">
        {claim.dateOfService}
      </td>
      <td className="px-3 py-2 text-xs uppercase tracking-wider text-slate-600">
        {claim.status}
      </td>
      <td className="px-3 py-2 text-xs text-slate-800 tabular-nums text-right whitespace-nowrap">
        {formatMoney(claim.totalBilledCents)}
      </td>
      <td className="px-3 py-2 text-xs">
        <Link
          href={`/admin/patients/${claim.patientId}`}
          className="underline decoration-dotted"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open patient →
        </Link>
      </td>
    </tr>
  );
}
