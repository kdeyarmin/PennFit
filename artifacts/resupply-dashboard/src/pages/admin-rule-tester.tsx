// /admin/rule-tester — "given hypothetical patient X, which rule
// fires and what cadence/channel does the worker pick?"
//
// Reads against the live frequency_rules table. Pure read-only —
// no rules are modified by running a simulation.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  type Channel,
  type RuleTestResponse,
  testRules,
} from "../lib/rule-tester-api";

export function AdminRuleTesterPage() {
  const [tenureDays, setTenureDays] = useState(180);
  const [insurancePayer, setInsurancePayer] = useState("");
  const [cadenceOverrideDays, setCadenceOverrideDays] = useState<string>("");
  const [channelPreference, setChannelPreference] = useState<Channel | "">("");
  const [hasPhone, setHasPhone] = useState(true);
  const [itemSku, setItemSku] = useState("MASK-NASAL-MED");
  const [cadenceDays, setCadenceDays] = useState(90);

  const sim = useMutation({
    mutationFn: () =>
      testRules({
        patient: {
          tenureDays,
          insurancePayer: insurancePayer.trim() || null,
          cadenceOverrideDays: cadenceOverrideDays
            ? Number(cadenceOverrideDays)
            : null,
          channelPreference: channelPreference || null,
          hasPhone,
        },
        prescription: {
          itemSku: itemSku.trim(),
          cadenceDays,
        },
      }),
  });

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-rule-tester-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Rule tester
        </h1>
        <p className="text-sm text-slate-600">
          Simulate a (patient, prescription) pair against the live
          frequency-rules table. Read-only — nothing is modified by
          running a test.{" "}
          <Link href="/rules" className="underline decoration-dotted" style={{ color: "hsl(var(--ink-1))" }}>
            Edit rules →
          </Link>
        </p>
      </header>

      <div className="grid lg:grid-cols-2 gap-6">
        <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold text-slate-700">
            Hypothetical patient
          </h2>
          <Field label="Tenure (days)" hint="How long they've been a patient">
            <input
              type="number"
              min={0}
              value={tenureDays}
              onChange={(e) => setTenureDays(Number(e.target.value) || 0)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <Field
            label="Insurance payer"
            hint="Free-form name (e.g. Aetna, Medicare). Leave blank for none."
          >
            <input
              type="text"
              value={insurancePayer}
              onChange={(e) => setInsurancePayer(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="(blank)"
            />
          </Field>
          <Field
            label="Cadence override (days)"
            hint="Leave blank if no per-patient override is set"
          >
            <input
              type="number"
              min={0}
              value={cadenceOverrideDays}
              onChange={(e) => setCadenceOverrideDays(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              placeholder="(none)"
            />
          </Field>
          <Field
            label="Channel preference"
            hint="Per-patient channel override; blank means none"
          >
            <select
              value={channelPreference}
              onChange={(e) =>
                setChannelPreference(
                  (e.target.value as Channel) || ("" as never),
                )
              }
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">(none)</option>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="voice">Voice</option>
            </select>
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={hasPhone}
              onChange={(e) => setHasPhone(e.target.checked)}
            />
            Patient has phone on file (drives default-channel fallback)
          </label>

          <h2 className="text-sm font-semibold text-slate-700 mt-4">
            Hypothetical prescription
          </h2>
          <Field label="Item SKU" hint="Used for prefix matches">
            <input
              type="text"
              value={itemSku}
              onChange={(e) => setItemSku(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm font-mono"
            />
          </Field>
          <Field
            label="Prescription cadenceDays"
            hint="Fallback cadence when no rule and no override applies"
          >
            <input
              type="number"
              min={1}
              value={cadenceDays}
              onChange={(e) => setCadenceDays(Number(e.target.value) || 1)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            />
          </Field>
          <div className="pt-2">
            <button
              type="button"
              onClick={() => sim.mutate()}
              disabled={sim.isPending || !itemSku.trim()}
              className="rounded bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              data-testid="rule-tester-run"
            >
              {sim.isPending ? "Simulating…" : "Run simulation"}
            </button>
          </div>
          {sim.error instanceof Error && (
            <p className="text-xs text-rose-700" role="alert">
              {sim.error.message}
            </p>
          )}
        </section>

        {sim.data && <ResultPanel data={sim.data} />}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-slate-600 block mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-[10px] text-slate-500 mt-0.5">{hint}</p>}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  patient_override: "patient override",
  rule: "rule",
  prescription: "prescription default",
  default_sms: "default (SMS — patient has phone)",
  default_email: "default (email — patient has no phone)",
};

function ResultPanel({ data }: { data: RuleTestResponse }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <h2 className="text-sm font-semibold text-slate-700">Result</h2>
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs uppercase tracking-wider text-emerald-900 font-semibold">
            Cadence
          </span>
          <span className="text-2xl font-bold tabular-nums text-emerald-900">
            {data.plan.cadenceDays}d
          </span>
        </div>
        <p className="text-[11px] text-emerald-800">
          Source: {SOURCE_LABEL[data.plan.cadenceSource] ?? data.plan.cadenceSource}
        </p>
      </div>
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs uppercase tracking-wider text-blue-900 font-semibold">
            Channel
          </span>
          <span className="text-2xl font-bold uppercase tracking-wider text-blue-900">
            {data.plan.channel}
          </span>
        </div>
        <p className="text-[11px] text-blue-800">
          Source: {SOURCE_LABEL[data.plan.channelSource] ?? data.plan.channelSource}
        </p>
      </div>
      {data.plan.matchedRuleId && (
        <div className="text-xs text-slate-600">
          Matched rule:{" "}
          <code className="font-mono">{data.plan.matchedRuleId}</code>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold text-slate-600 mt-2 mb-1">
          All rules evaluated ({data.evaluated.length})
        </h3>
        {data.evaluated.length === 0 ? (
          <p className="text-xs text-slate-500">No rules configured.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.evaluated.map((r) => (
              <li
                key={r.id}
                className={`rounded border p-2 text-xs ${
                  r.matched
                    ? "border-emerald-300 bg-emerald-50"
                    : r.active
                      ? "border-slate-200 bg-white"
                      : "border-slate-200 bg-slate-50 opacity-70"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-slate-700">
                    p{r.priority} · {r.cadenceDays}d ·{" "}
                    {r.defaultChannel ?? "no channel pref"}
                  </span>
                  {r.matched ? (
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-800">
                      matched
                    </span>
                  ) : !r.active ? (
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">
                      inactive
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-slate-600 mt-0.5">
                  {r.matchItemSkuPrefix && <>SKU starts with <code>{r.matchItemSkuPrefix}</code> · </>}
                  {r.matchInsurancePayer && <>payer = <code>{r.matchInsurancePayer}</code> · </>}
                  {r.minTenureDays !== null && <>tenure ≥ {r.minTenureDays}d · </>}
                  {r.maxTenureDays !== null && <>tenure ≤ {r.maxTenureDays}d · </>}
                  {!r.matchItemSkuPrefix &&
                    !r.matchInsurancePayer &&
                    r.minTenureDays === null &&
                    r.maxTenureDays === null &&
                    "no constraints (catch-all)"}
                </div>
                {!r.matched && r.active && r.reasonsForNoMatch.length > 0 && (
                  <ul className="text-[10px] text-rose-700 mt-1 list-disc pl-4">
                    {r.reasonsForNoMatch.map((reason, i) => (
                      <li key={i}>{reason}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
