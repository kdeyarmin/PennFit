// /admin/billing/config/fee-schedules — payer + HCPCS expected-
// allowed amounts. Optional filter by payer or HCPCS so the
// list-of-all-rows (≤ 500) doesn't blow past PostgREST's row cap
// on a large book.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPayerFeeSchedules,
  fetchPayerProfiles,
  formatMoneyCents,
  type PayerProfile,
} from "@/lib/admin/billing-config-api";

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
