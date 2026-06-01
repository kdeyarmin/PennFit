// /admin/billing/config/fee-schedules — payer + HCPCS expected-
// allowed amounts. Optional filter by payer or HCPCS so the
// list-of-all-rows (≤ 500) doesn't blow past PostgREST's row cap
// on a large book.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPayerFeeSchedules,
  fetchPayerProfiles,
  formatMoneyCents,
  importPayerFeeScheduleCsv,
  type FeeScheduleImportResult,
  type PayerProfile,
} from "@/lib/admin/billing-config-api";

const CSV_HEADER =
  "hcpcs_code,modifier,allowed_cents,effective_from,effective_through,source,notes";
const CSV_SAMPLE = `${CSV_HEADER}\nE0601,RR,12235,2026-01-01,,cms_published,Medicare DME 2026\nA7038,,4200,2026-01-01,,payer_published,`;

export function AdminBillingConfigFeeSchedulesPage() {
  const [payerProfileId, setPayerProfileId] = useState("");
  const [hcpcs, setHcpcs] = useState("");

  const payers = useQuery({
    queryKey: ["admin-payer-profiles-min"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60_000,
  });
  const schedules = useQuery({
    queryKey: ["admin-payer-fee-schedules", { payerProfileId, hcpcs }],
    queryFn: () =>
      fetchPayerFeeSchedules({
        payerProfileId: payerProfileId || undefined,
        hcpcs: hcpcs.toUpperCase() || undefined,
      }),
    staleTime: 60_000,
  });

  const payerMap = useMemo(() => {
    const m = new Map<string, PayerProfile>();
    for (const p of payers.data?.payerProfiles ?? []) m.set(p.id, p);
    return m;
  }, [payers.data]);

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-config-fee-schedules"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Fee schedules
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Per-payer + HCPCS expected-allowed amounts.
          {schedules.data?.feeSchedules.length != null && (
            <> {schedules.data.feeSchedules.length} row(s).</>
          )}
        </p>
      </header>

      {schedules.isError && (
        <ErrorPanel
          error={schedules.error}
          onRetry={() => void schedules.refetch()}
        />
      )}

      <Card title="Filters">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Payer
            </span>
            <select
              value={payerProfileId}
              onChange={(e) => setPayerProfileId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[220px]"
            >
              <option value="">All</option>
              {(payers.data?.payerProfiles ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              HCPCS
            </span>
            <input
              type="text"
              value={hcpcs}
              onChange={(e) => setHcpcs(e.target.value)}
              placeholder="A4604"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono uppercase w-[110px]"
            />
          </label>
        </div>
      </Card>

      <ImportCard
        payers={payers.data?.payerProfiles ?? []}
        onImported={() => void schedules.refetch()}
      />

      <Card>
        {schedules.isPending ? (
          <Spinner label="Loading fee schedules…" />
        ) : (schedules.data?.feeSchedules.length ?? 0) === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No fee schedule rows match.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Payer</th>
                  <th className="p-3">HCPCS</th>
                  <th className="p-3">Modifier</th>
                  <th className="p-3 text-right">Allowed</th>
                  <th className="p-3">Effective</th>
                  <th className="p-3">Source</th>
                </tr>
              </thead>
              <tbody>
                {(schedules.data?.feeSchedules ?? []).map((s) => (
                  <tr
                    key={s.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="p-3 font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {payerMap.get(s.payerProfileId)?.displayName ??
                        s.payerProfileId.slice(0, 8)}
                    </td>
                    <td
                      className="p-3 font-mono text-[12px]"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {s.hcpcsCode}
                    </td>
                    <td
                      className="p-3 font-mono text-[12px]"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {s.modifier ?? "—"}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {formatMoneyCents(s.allowedCents)}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <span className="block">{s.effectiveFrom}</span>
                      {s.effectiveThrough && (
                        <span className="block">→ {s.effectiveThrough}</span>
                      )}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {s.source ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// Bulk import card. Paste a CSV (header + rows), pick the payer, submit.
// The server (admin-only) validates each row and reports row-level
// errors without blocking the valid rows. No upsert — operators close
// prior rows by setting effective_through, matching the export format.
function ImportCard({
  payers,
  onImported,
}: {
  payers: PayerProfile[];
  onImported: () => void;
}) {
  const qc = useQueryClient();
  const [payerProfileId, setPayerProfileId] = useState("");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<FeeScheduleImportResult | null>(null);

  const importMutation = useMutation({
    mutationFn: () => importPayerFeeScheduleCsv(payerProfileId, csv),
    onSuccess: (res) => {
      setResult(res);
      if (res.accepted > 0) {
        setCsv("");
        void qc.invalidateQueries({ queryKey: ["admin-payer-fee-schedules"] });
        onImported();
      }
    },
  });

  const canSubmit =
    payerProfileId !== "" &&
    csv.trim().length >= 20 &&
    !importMutation.isPending;

  return (
    <Card title="Import fee schedule (CSV)">
      <div className="space-y-3">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Paste a CSV with the header{" "}
          <code className="font-mono text-[11px]">{CSV_HEADER}</code>. One row
          per HCPCS + modifier. <code className="font-mono">allowed_cents</code>{" "}
          is whole cents; <code className="font-mono">source</code> is one of
          manual / cms_published / payer_published / observed. Admin-only.
        </p>
        <div className="flex flex-wrap gap-3 items-end">
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Payer
            </span>
            <select
              value={payerProfileId}
              onChange={(e) => setPayerProfileId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[220px]"
              aria-label="Import payer"
            >
              <option value="">Select a payer…</option>
              {payers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={CSV_SAMPLE}
          rows={6}
          aria-label="Fee schedule CSV"
          className="w-full rounded border border-slate-300 px-3 py-2 text-xs font-mono"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => {
              setResult(null);
              importMutation.mutate();
            }}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            data-testid="fee-schedule-import-submit"
          >
            {importMutation.isPending ? "Importing…" : "Import rows"}
          </button>
          {payerProfileId === "" && (
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Pick a payer first.
            </span>
          )}
        </div>

        {importMutation.error instanceof Error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
            {importMutation.error.message}
          </div>
        )}

        {result && (
          <div
            className="rounded border p-3 text-xs"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="fee-schedule-import-result"
          >
            <p className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
              Imported {result.accepted} row(s)
              {result.errors.length > 0
                ? ` · ${result.errors.length} skipped`
                : ""}
              .
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {result.errors.slice(0, 25).map((e, i) => (
                  <li key={i} className="text-rose-800">
                    Row {e.row}: {e.reason}
                  </li>
                ))}
                {result.errors.length > 25 && (
                  <li style={{ color: "hsl(var(--ink-3))" }}>
                    …and {result.errors.length - 25} more.
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
