// /admin/billing/config/denial-codes — CARC/RARC catalog the AI
// denial analyzer matches against.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { fetchDenialCodes } from "@/lib/admin/billing-config-api";

export function AdminBillingConfigDenialCodesPage() {
  const [codeSystem, setCodeSystem] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-denial-codes", { codeSystem, category, q }],
    queryFn: () =>
      fetchDenialCodes({
        codeSystem: codeSystem || undefined,
        category: category || undefined,
        q: q || undefined,
      }),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-config-denial-codes"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Denial codes
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          CARC + RARC catalog seeded with the ~50 codes DME suppliers hit most
          often. {data?.denialCodes.length ?? 0} match.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <Card title="Filters">
        <div className="flex flex-wrap gap-3 items-end">
          <FilterSelect
            label="Code system"
            value={codeSystem}
            onChange={setCodeSystem}
            options={[
              { value: "", label: "All" },
              { value: "CARC", label: "CARC" },
              { value: "RARC", label: "RARC" },
            ]}
          />
          <FilterSelect
            label="Category"
            value={category}
            onChange={setCategory}
            options={[
              { value: "", label: "All" },
              { value: "documentation", label: "Documentation" },
              { value: "eligibility", label: "Eligibility" },
              { value: "coding", label: "Coding" },
              { value: "medical_necessity", label: "Medical necessity" },
              { value: "duplicate", label: "Duplicate" },
              { value: "auth_required", label: "Auth required" },
              { value: "other", label: "Other" },
            ]}
          />
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Description contains
            </span>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[180px]"
            />
          </label>
        </div>
      </Card>

      <Card>
        {isPending ? (
          <Spinner label="Loading denial codes…" />
        ) : !isError && (data?.denialCodes.length ?? 0) === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No denial codes match.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">System</th>
                  <th className="p-3">Code</th>
                  <th className="p-3">Description</th>
                  <th className="p-3">Category</th>
                  <th className="p-3">Recommended action</th>
                  <th className="p-3">Terminal</th>
                </tr>
              </thead>
              <tbody>
                {(data?.denialCodes ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                      {c.codeSystem}
                    </td>
                    <td
                      className="p-3 font-mono font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {c.code}
                    </td>
                    <td className="p-3" style={{ color: "hsl(var(--ink-1))" }}>
                      {c.description}
                    </td>
                    <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                      {c.category}
                    </td>
                    <td
                      className="p-3 text-[12px]"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {c.recommendedAction ?? "—"}
                    </td>
                    <td className="p-3">
                      {c.isTerminal ? (
                        <span style={{ color: "#b91c1c" }}>yes</span>
                      ) : (
                        <span style={{ color: "hsl(var(--ink-3))" }}>no</span>
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

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
