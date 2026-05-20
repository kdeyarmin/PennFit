// /admin/billing/config/modifier-rules — payer-specific HCPCS
// modifier policy. Sorted by payer, HCPCS, priority so the rules
// that fire first show first.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPayerModifierRules,
  fetchPayerProfiles,
  type PayerProfile,
} from "@/lib/admin/billing-config-api";

export function AdminBillingConfigModifierRulesPage() {
  const [payerProfileId, setPayerProfileId] = useState("");
  const [hcpcs, setHcpcs] = useState("");

  const payers = useQuery({
    queryKey: ["admin-payer-profiles-min"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60_000,
  });
  const rules = useQuery({
    queryKey: ["admin-payer-modifier-rules", { payerProfileId, hcpcs }],
    queryFn: () =>
      fetchPayerModifierRules({
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
      data-testid="admin-billing-config-modifier-rules"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Modifier rules
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Per-payer HCPCS modifier policy applied by the claim-builder.{" "}
          {rules.data?.rules.length ?? 0} rule(s).
        </p>
      </header>

      {rules.isError && (
        <ErrorPanel error={rules.error} onRetry={() => void rules.refetch()} />
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
              placeholder="E0601"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono uppercase w-[110px]"
            />
          </label>
        </div>
      </Card>

      <Card>
        {rules.isPending ? (
          <Spinner label="Loading modifier rules…" />
        ) : !rules.isError && (rules.data?.rules.length ?? 0) === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No rules match.
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
                  <th className="p-3">Condition</th>
                  <th className="p-3">Modifiers</th>
                  <th className="p-3 text-right">Priority</th>
                  <th className="p-3">Rationale</th>
                  <th className="p-3">Active</th>
                </tr>
              </thead>
              <tbody>
                {(rules.data?.rules ?? []).map((r) => (
                  <tr
                    key={r.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td
                      className="p-3 font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {payerMap.get(r.payerProfileId)?.displayName ??
                        r.payerProfileId.slice(0, 8)}
                    </td>
                    <td
                      className="p-3 font-mono text-[12px]"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {r.hcpcsCode}
                    </td>
                    <td
                      className="p-3 font-mono text-[12px]"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {r.condition}
                    </td>
                    <td
                      className="p-3 font-mono text-[12px] font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {r.modifiersCsv}
                    </td>
                    <td
                      className="p-3 text-right tabular-nums"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {r.priority}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {r.rationale ?? "—"}
                    </td>
                    <td className="p-3">
                      {r.isActive ? (
                        <span style={{ color: "#15803d" }}>active</span>
                      ) : (
                        <span style={{ color: "hsl(var(--ink-3))" }}>
                          inactive
                        </span>
                      )}
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
