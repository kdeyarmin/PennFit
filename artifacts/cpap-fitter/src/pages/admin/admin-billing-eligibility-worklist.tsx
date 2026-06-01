// /admin/billing/eligibility-worklist — coverages due for re-verification
// (Biller #31, read-only half).
//
// The per-coverage 270/271 re-verify already exists on the patient
// page; this is the "who should I re-check this week" list, ranked
// never-verified / terminating-soon / stale. Each row deep-links to the
// patient so the operator can fire the existing verify action.
//
// reports.read-gated server-side; nav gated to match. Coverage metadata
// only — member id is shown as last-4.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { Badge } from "@/components/admin/Badge";
import {
  fetchEligibilityVerificationWorklist,
  runEligibilityBatch,
  type ReverifyBatchSummary,
  type VerificationStatus,
  type VerificationWorkItem,
} from "@/lib/admin/eligibility-verification-worklist-api";

const STALE_WINDOWS = [
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
];

const STATUS_META: Record<
  VerificationStatus,
  { label: string; variant: "danger" | "warning" | "info" | "muted" }
> = {
  terminating_soon: { label: "Terminating soon", variant: "danger" },
  never_verified: { label: "Never verified", variant: "warning" },
  stale: { label: "Stale", variant: "info" },
  ok: { label: "OK", variant: "muted" },
};

export function AdminBillingEligibilityWorklistPage() {
  const [staleDays, setStaleDays] = useState(30);
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [
      "admin",
      "eligibility-verification-worklist",
      staleDays,
    ] as const,
    queryFn: () => fetchEligibilityVerificationWorklist(staleDays),
    refetchInterval: 300_000,
  });

  const [lastRun, setLastRun] = useState<ReverifyBatchSummary | null>(null);
  const batch = useMutation({
    mutationFn: () => runEligibilityBatch({ staleDays }),
    onSuccess: (res) => {
      setLastRun(res.summary);
      void qc.invalidateQueries({
        queryKey: ["admin", "eligibility-verification-worklist"],
      });
    },
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-6xl"
      data-testid="admin-eligibility-worklist-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" />
            Eligibility re-verification
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Active coverages ranked by re-verification urgency — re-check these
            before a claim denies for inactive coverage. Open a row to run the
            270/271 from the patient page.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            Stale after
            <select
              value={staleDays}
              onChange={(e) => setStaleDays(Number(e.target.value))}
              className="rounded border border-slate-300 px-2 py-1 text-xs"
            >
              {STALE_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            isLoading={batch.isPending}
            onClick={() => batch.mutate()}
            title="Fire a 270 for the most urgent coverages not checked recently (capped per run)"
          >
            Run batch now
          </Button>
        </div>
      </header>

      {lastRun && (
        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "hsl(var(--line-1))",
            color: "hsl(var(--ink-2))",
          }}
          role="status"
        >
          Last run — scanned {lastRun.scanned}, due {lastRun.due}, fired{" "}
          {lastRun.fired} (uploaded {lastRun.uploadOk}
          {lastRun.errored > 0 ? `, ${lastRun.errored} errored` : ""}).
        </div>
      )}
      {batch.error instanceof Error && (
        <div className="text-xs" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t run the batch. You may not have permission, or the
          clearinghouse is unreachable.
        </div>
      )}

      {query.isPending ? (
        <Spinner label="Loading worklist…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <CountChip
              label="Terminating soon"
              value={query.data.counts.terminatingSoon}
              variant="danger"
            />
            <CountChip
              label="Never verified"
              value={query.data.counts.neverVerified}
              variant="warning"
            />
            <CountChip
              label="Stale"
              value={query.data.counts.stale}
              variant="info"
            />
            <CountChip
              label="OK"
              value={query.data.counts.ok}
              variant="muted"
            />
          </div>
          <WorklistTable items={query.data.items} />
        </>
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
  variant: "danger" | "warning" | "info" | "muted";
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <Badge variant={variant}>{value}</Badge>
      <span className="text-slate-600">{label}</span>
    </span>
  );
}

function WorklistTable({ items }: { items: VerificationWorkItem[] }) {
  if (items.length === 0) {
    return (
      <Card>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No coverages need re-verification. 🎉
        </p>
      </Card>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm min-w-[820px]">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-600">
          <tr>
            <th className="text-left px-3 py-2">Status</th>
            <th className="text-left px-3 py-2">Payer</th>
            <th className="text-left px-3 py-2">Rank</th>
            <th className="text-left px-3 py-2">Member</th>
            <th className="text-left px-3 py-2">Last verified</th>
            <th className="text-left px-3 py-2">Terminates</th>
            <th className="text-left px-3 py-2">Patient</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const meta = STATUS_META[c.status];
            return (
              <tr
                key={c.id}
                className="border-t border-slate-100 hover:bg-slate-50"
              >
                <td className="px-3 py-2">
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                </td>
                <td className="px-3 py-2 text-slate-800">
                  {c.payerName ?? <span className="text-slate-400">—</span>}
                </td>
                <td className="px-3 py-2 text-xs uppercase tracking-wider text-slate-600">
                  {c.rank}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">
                  {c.memberIdTail ? `••••${c.memberIdTail}` : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600 tabular-nums">
                  {c.verifiedAt ? (
                    <>
                      {new Date(c.verifiedAt).toLocaleDateString()}
                      {c.daysSinceVerified != null && (
                        <span className="text-slate-400">
                          {" "}
                          ({c.daysSinceVerified}d)
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-amber-700">never</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums">
                  {c.terminationDate ? (
                    <span
                      style={{
                        color:
                          c.status === "terminating_soon"
                            ? "#b91c1c"
                            : "hsl(var(--ink-2))",
                      }}
                    >
                      {c.terminationDate}
                      {c.daysUntilTermination != null &&
                        c.daysUntilTermination >= 0 && (
                          <span> ({c.daysUntilTermination}d)</span>
                        )}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">
                  <Link
                    href={`/admin/patients/${c.patientId}`}
                    className="underline decoration-dotted"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    Open →
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
