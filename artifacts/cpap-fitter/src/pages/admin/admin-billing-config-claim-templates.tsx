// /admin/billing/config/claim-templates — reusable HCPCS line
// patterns the claim-builder snaps to when a fulfillment becomes a
// claim. Each template has 1..N lines and (optional) default diagnosis
// codes; some are scoped to a single payer.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchClaimTemplates,
  fetchPayerProfiles,
  formatMoneyCents,
  type PayerProfile,
} from "@/lib/admin/billing-config-api";

export function AdminBillingConfigClaimTemplatesPage() {
  const payers = useQuery({
    queryKey: ["admin-payer-profiles-min"],
    queryFn: () => fetchPayerProfiles(),
    staleTime: 5 * 60_000,
  });
  const templates = useQuery({
    queryKey: ["admin-claim-templates"],
    queryFn: fetchClaimTemplates,
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
      data-testid="admin-billing-config-claim-templates"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Claim templates
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Reusable HCPCS line patterns. {templates.data?.templates.length ?? 0}{" "}
          on file.
        </p>
      </header>

      {templates.isError ? (
        <ErrorPanel
          error={templates.error}
          onRetry={() => void templates.refetch()}
        />
      ) : templates.isPending ? (
        <Spinner label="Loading templates…" />
      ) : (templates.data?.templates.length ?? 0) === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No claim templates configured.
          </p>
        </Card>
      ) : (
        (templates.data?.templates ?? []).map((t) => (
          <Card
            key={t.id}
            title={
              <span className="inline-flex items-center gap-2">
                {t.displayName}
                {!t.isActive && (
                  <span
                    className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase"
                    style={{
                      backgroundColor: "rgba(0,0,0,0.06)",
                      color: "hsl(var(--ink-3))",
                    }}
                  >
                    inactive
                  </span>
                )}
              </span>
            }
            subtitle={
              <span className="space-x-3">
                <span>slug: {t.slug}</span>
                {t.scopedPayerProfileId && (
                  <span>
                    scoped to{" "}
                    {payerMap.get(t.scopedPayerProfileId)?.displayName ??
                      t.scopedPayerProfileId.slice(0, 8)}
                  </span>
                )}
              </span>
            }
          >
            {t.description && (
              <p
                className="text-sm mb-3"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                {t.description}
              </p>
            )}
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left text-[11px] uppercase tracking-wider"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    <th className="px-5 py-1.5">HCPCS</th>
                    <th className="px-3 py-1.5">Modifier</th>
                    <th className="px-3 py-1.5">Description</th>
                    <th className="px-3 py-1.5 text-right">Qty</th>
                    <th className="px-3 py-1.5 text-right">Charge</th>
                  </tr>
                </thead>
                <tbody>
                  {t.lines.map((l, i) => (
                    <tr
                      key={i}
                      className="border-t"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                    >
                      <td
                        className="px-5 py-2 font-mono text-[12px] font-semibold"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {l.hcpcsCode}
                      </td>
                      <td
                        className="px-3 py-2 font-mono text-[12px]"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {l.modifier ?? "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-[12px]"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {l.description ?? "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {l.quantity ?? "—"}
                      </td>
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {formatMoneyCents(l.chargeCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {t.defaultDiagnosisCodes.length > 0 && (
              <p
                className="text-xs mt-3"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Default ICD-10:{" "}
                <span className="font-mono">
                  {t.defaultDiagnosisCodes.join(", ")}
                </span>
              </p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
