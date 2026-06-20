// /admin/billing/config/cms-import — import the Medicare CMS DMEPOS fee
// schedule (the quarterly public-use grid) into payer_fee_schedules for a
// payer + state. Paste the state's CSV (or the full national grid), pick the
// effective date, and the server replaces any prior CMS import for that
// quarter. See lib/billing/cms-dmepos-fee-schedule.ts.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import {
  fetchPayerProfiles,
  importPayerFeeScheduleCms,
  type CmsFeeScheduleImportResult,
} from "@/lib/admin/billing-config-api";

export function AdminBillingConfigCmsImportPage() {
  const [payerProfileId, setPayerProfileId] = useState("");
  const [state, setState] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [rural, setRural] = useState(false);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<CmsFeeScheduleImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const payers = useQuery({
    queryKey: ["admin-payer-profiles-min"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60_000,
  });

  const canSubmit =
    payerProfileId !== "" &&
    /^[A-Za-z]{2}$/.test(state.trim()) &&
    /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) &&
    csv.trim().length >= 20 &&
    !submitting;

  const submit = async () => {
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const res = await importPayerFeeScheduleCms({
        payerProfileId,
        state: state.trim().toUpperCase(),
        effectiveFrom,
        rural,
        csv,
      });
      setResult(res);
      if (res.accepted > 0) setCsv("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="admin-root space-y-6 max-w-4xl"
      data-testid="admin-billing-config-cms-import"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          CMS fee-schedule import
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Bulk-load Medicare allowable amounts from the quarterly CMS DMEPOS fee
          schedule (the{" "}
          <code className="font-mono">DMEPOS&lt;YY&gt;_&lt;MON&gt;.csv</code>{" "}
          grid). Choose the Medicare DME payer + your state; the server reads
          that state&rsquo;s column and replaces any prior import for the same
          effective date.
        </p>
      </header>

      <Card title="Import">
        <div className="space-y-3">
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
                aria-label="Payer"
              >
                <option value="">Select a payer…</option>
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
                State
              </span>
              <input
                type="text"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="PA"
                maxLength={2}
                aria-label="State"
                className="rounded border border-slate-300 px-2 py-1.5 text-sm font-mono uppercase w-[70px]"
              />
            </label>
            <label className="block">
              <span
                className="text-xs font-semibold block mb-1"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Effective from
              </span>
              <input
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                aria-label="Effective from"
                className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 pb-1.5">
              <input
                type="checkbox"
                checked={rural}
                onChange={(e) => setRural(e.target.checked)}
                aria-label="Rural fees"
              />
              <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
                Rural (R) column
              </span>
            </label>
          </div>

          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="Paste the CMS DMEPOS CSV grid (HCPCS,Mod,Mod2,JURIS,CATG,Ceiling,Floor,…,PA (NR),PA (R),…,Description)"
            rows={8}
            aria-label="CMS DMEPOS CSV"
            className="w-full rounded border border-slate-300 px-3 py-2 text-xs font-mono"
          />

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit()}
              className="rounded bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
              data-testid="cms-import-submit"
            >
              {submitting ? "Importing…" : "Import fees"}
            </button>
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Replaces the prior CMS import for this payer + effective date.
            </span>
          </div>

          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
              {error}
            </div>
          )}

          {result && (
            <div
              className="rounded border p-3 text-xs"
              style={{ borderColor: "hsl(var(--line-1))" }}
              data-testid="cms-import-result"
            >
              <p
                className="font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Imported {result.accepted} fee row(s).
              </p>
              {result.warnings.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {result.warnings.slice(0, 10).map((w, i) => (
                    <li key={i} style={{ color: "hsl(var(--ink-3))" }}>
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
