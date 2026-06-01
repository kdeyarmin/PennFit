// /admin/billing/denials-worklist — denied claims ranked by recoverable
// dollars × win-probability (Biller #33).
//
// The denial-rate page and the AI queue already exist; this is the
// "work the next-best denial" list. Each row deep-links to the patient's
// claim workbench where the existing resubmit / appeal actions live, so
// this page stays read-only.
//
// reports.read-gated server-side; nav gated to match. Claim metadata +
// the AI recommendation enum/confidence only — no patient clinical data.

import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Gavel } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { Badge } from "@/components/admin/Badge";
import {
  fetchDenialsWorklist,
  type DenialRecommendation,
  type DenialsWorklistResponse,
  type DenialWorkItem,
} from "@/lib/admin/denials-worklist-api";

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

const REC_LABEL: Record<DenialRecommendation, string> = {
  auto_resubmit: "Auto-resubmit",
  manual_resubmit: "Manual resubmit",
  appeal: "Appeal",
  bill_patient: "Bill patient",
  write_off: "Write off",
  manual_review: "Manual review",
};

const REC_VARIANT: Record<
  DenialRecommendation,
  "success" | "info" | "warning" | "muted"
> = {
  auto_resubmit: "success",
  manual_resubmit: "info",
  appeal: "info",
  bill_patient: "warning",
  write_off: "muted",
  manual_review: "warning",
};

export function AdminBillingDenialsWorklistPage() {
  const query = useQuery({
    queryKey: ["admin", "denials-worklist"],
    queryFn: fetchDenialsWorklist,
    refetchInterval: 120_000,
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-denials-worklist-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Gavel className="h-6 w-6" />
          Denials worklist
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Open denials ranked by recoverable dollars × win-probability — work
          the top of the list first. Recoverable is billed − paid;
          win-probability is the AI analysis confidence (a conservative default
          until a claim is analyzed). Open a row to resubmit or appeal.
        </p>
      </header>

      {query.isPending ? (
        <Spinner label="Loading denials…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <TotalsCards data={query.data} />
          <WorklistTable items={query.data.items} />
        </>
      )}
    </div>
  );
}

function TotalsCards({ data }: { data: DenialsWorklistResponse }) {
  const t = data.totals;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Metric label="Open denials" value={String(t.count)} />
      <Metric label="Recoverable" value={money(t.recoverableCents)} />
      <Metric
        label="Expected recoverable"
        value={money(t.expectedRecoverableCents)}
        hint="recoverable × win-prob"
      />
      <Metric
        label="Auto-resubmittable"
        value={String(t.autoResubmittable)}
        hint={
          t.unanalyzed > 0 ? `${t.unanalyzed} not yet analyzed` : "all analyzed"
        }
        warn={t.unanalyzed > 0}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <Card>
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
      </p>
      {hint && (
        <p
          className="text-[11px] mt-1"
          style={{ color: warn ? "#b45309" : "hsl(var(--ink-3))" }}
        >
          {hint}
        </p>
      )}
    </Card>
  );
}

function WorklistTable({ items }: { items: DenialWorkItem[] }) {
  const rows = useMemo(() => items, [items]);
  if (rows.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No open denials. 🎉
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-right px-3 py-2">#</th>
            <th className="text-left px-3 py-2">Payer</th>
            <th className="text-right px-3 py-2">Recoverable</th>
            <th className="text-right px-3 py-2">Win&nbsp;%</th>
            <th className="text-right px-3 py-2">Expected</th>
            <th className="text-left px-3 py-2">Recommendation</th>
            <th className="text-left px-3 py-2">Denial</th>
            <th className="text-left px-3 py-2">Claim</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr
              key={d.claimId}
              className="border-t border-slate-100 hover:bg-slate-50"
            >
              <td className="px-3 py-2 text-right tabular-nums text-slate-400">
                {i + 1}
              </td>
              <td className="px-3 py-2 text-slate-800">
                {d.payerName ?? <span className="text-slate-400">—</span>}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {money(d.recoverableCents)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Math.round(d.winProbability * 100)}%
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {money(d.scoreCents)}
              </td>
              <td className="px-3 py-2">
                {d.recommendation ? (
                  <Badge variant={REC_VARIANT[d.recommendation]}>
                    {REC_LABEL[d.recommendation]}
                  </Badge>
                ) : (
                  <span className="text-xs text-amber-700">not analyzed</span>
                )}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-slate-600">
                {d.denialReason ?? "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                <Link
                  href={`/admin/patients/${d.patientId}`}
                  className="underline decoration-dotted"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  Open claim →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
