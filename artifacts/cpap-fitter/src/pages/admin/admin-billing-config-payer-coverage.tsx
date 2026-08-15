// /admin/billing/config/payer-coverage-diagnoses — per-payer medical-
// necessity coverage overrides. Pick a payer, then add/remove the ICD-10
// codes that support a HCPCS for that payer. A payer's set for a HCPCS
// REPLACES the national Medicare-LCD default in the claim preflight
// diagnosis check (migration 0415; lib/billing/coverage-diagnosis.ts).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  createPayerCoverageDiagnosis,
  deletePayerCoverageDiagnosis,
  fetchPayerCoverageDiagnoses,
  fetchPayerProfiles,
  type PayerCoverageDiagnosis,
} from "@/lib/admin/billing-config-api";

const COVERAGE_KEY = "admin-payer-coverage-diagnoses";

export function AdminBillingConfigPayerCoveragePage() {
  const [payerProfileId, setPayerProfileId] = useState("");

  const payers = useQuery({
    queryKey: ["admin-payer-profiles-min"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60_000,
  });
  const overrides = useQuery({
    queryKey: [COVERAGE_KEY, payerProfileId],
    queryFn: () => fetchPayerCoverageDiagnoses(payerProfileId),
    enabled: payerProfileId !== "",
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-5xl"
      data-testid="admin-billing-config-payer-coverage"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Coverage overrides
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Per-payer medical-necessity coverage. A payer&rsquo;s ICD-10 set for a
          HCPCS replaces the national Medicare-LCD default in the claim
          preflight diagnosis check. Leave a payer empty to keep the national
          coverage.
        </p>
      </header>

      {overrides.isError && (
        <ErrorPanel
          error={overrides.error}
          onRetry={() => void overrides.refetch()}
        />
      )}

      <Card title="Payer">
        <select
          value={payerProfileId}
          onChange={(e) => setPayerProfileId(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[260px]"
          aria-label="Payer"
        >
          <option value="">Select a payer…</option>
          {(payers.data?.payerProfiles ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </Card>

      {payerProfileId !== "" && (
        <>
          <AddOverrideCard
            payerProfileId={payerProfileId}
            onAdded={() => void overrides.refetch()}
          />
          <Card>
            {overrides.isPending ? (
              <Spinner label="Loading overrides…" />
            ) : (overrides.data?.overrides?.length ?? 0) === 0 ? (
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No overrides for this payer — the national Medicare-LCD coverage
                applies.
              </p>
            ) : (
              <div className="overflow-x-auto -mx-5 -my-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr
                      className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      <th scope="col" className="p-3">
                        HCPCS
                      </th>
                      <th scope="col" className="p-3">
                        ICD-10
                      </th>
                      <th scope="col" className="p-3">
                        Description
                      </th>
                      <th scope="col" className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {(overrides.data?.overrides ?? []).map((o) => (
                      <OverrideRow
                        key={o.id}
                        override={o}
                        onDeleted={() => void overrides.refetch()}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function OverrideRow({
  override,
  onDeleted,
}: {
  override: PayerCoverageDiagnosis;
  onDeleted: () => void;
}) {
  const del = useMutation({
    mutationFn: () => deletePayerCoverageDiagnosis(override.id),
    onSuccess: onDeleted,
  });
  return (
    <tr className="border-t" style={{ borderColor: "hsl(var(--line-1))" }}>
      <td
        className="p-3 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {override.hcpcsCode}
      </td>
      <td
        className="p-3 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {override.icd10Code}
      </td>
      <td className="p-3 text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
        {override.description ?? "—"}
      </td>
      <td className="p-3 text-right">
        <button
          type="button"
          disabled={del.isPending}
          onClick={() => del.mutate()}
          className="text-xs text-rose-700 hover:underline disabled:opacity-60"
        >
          {del.isPending ? "Removing…" : "Remove"}
        </button>
      </td>
    </tr>
  );
}

// Inline create form: HCPCS + ICD-10 (+ optional description) → POST.
function AddOverrideCard({
  payerProfileId,
  onAdded,
}: {
  payerProfileId: string;
  onAdded: () => void;
}) {
  const qc = useQueryClient();
  const [hcpcs, setHcpcs] = useState("");
  const [icd10, setIcd10] = useState("");
  const [description, setDescription] = useState("");

  const add = useMutation({
    mutationFn: () =>
      createPayerCoverageDiagnosis({
        payerProfileId,
        hcpcs: hcpcs.trim().toUpperCase(),
        icd10: icd10.trim().toUpperCase(),
        description: description.trim() || undefined,
      }),
    onSuccess: () => {
      setHcpcs("");
      setIcd10("");
      setDescription("");
      void qc.invalidateQueries({ queryKey: [COVERAGE_KEY] });
      onAdded();
    },
  });

  const canSubmit =
    /^[A-Za-z]\d{4}$/.test(hcpcs.trim()) &&
    icd10.trim().length >= 2 &&
    !add.isPending;

  return (
    <Card title="Add override">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
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
              aria-label="HCPCS code"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono uppercase w-[110px]"
            />
          </label>
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              ICD-10
            </span>
            <input
              type="text"
              value={icd10}
              onChange={(e) => setIcd10(e.target.value)}
              placeholder="G47.33"
              aria-label="ICD-10 code"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono uppercase w-[120px]"
            />
          </label>
          <label className="block grow">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Description
            </span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="optional"
              aria-label="Description"
              className="rounded border border-slate-300 px-2 py-1.5 text-sm w-full min-w-[160px]"
            />
          </label>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => add.mutate()}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            data-testid="coverage-override-add"
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          HCPCS like <code className="font-mono">E0601</code>; ICD-10 like{" "}
          <code className="font-mono">G47.33</code> (a category prefix such as{" "}
          <code className="font-mono">J44</code> covers the whole family).
        </p>
        {add.error instanceof Error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
            {add.error.message}
          </div>
        )}
      </div>
    </Card>
  );
}
