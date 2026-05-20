// /admin/billing/config/payers — Pennsylvania payer-profile catalog.
//
// Filters: region, LOB, active flag, name search. The PA payer list
// drives every other config table (fee schedules, modifier rules,
// claim templates all carry a payer_profile_id). Make this list
// browseable so an operator can confirm "yes, we have UPMC" before
// staging a fee-schedule import.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPayerProfiles,
  type PayerProfile,
} from "@/lib/admin/billing-config-api";

export function AdminBillingConfigPayersPage() {
  const [search, setSearch] = useState("");
  const [region, setRegion] = useState("");
  const [lob, setLob] = useState("");
  const [active, setActive] = useState<"" | "true" | "false">("true");

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-payer-profiles", { search, region, lob, active }],
    queryFn: () =>
      fetchPayerProfiles({
        q: search || undefined,
        region: region || undefined,
        lineOfBusiness: lob || undefined,
        active: active || undefined,
      }),
    staleTime: 60_000,
  });

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-config-payers"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Payer profiles
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          The PA payer catalog backing every claim header. {data?.payerProfiles.length ?? 0} match the current filters.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <Card title="Filters">
        <div className="flex flex-wrap gap-3 items-end">
          <FilterInput
            label="Name search"
            value={search}
            onChange={setSearch}
            placeholder="UPMC, Aetna, …"
          />
          <FilterSelect
            label="Region"
            value={region}
            onChange={setRegion}
            options={[
              { value: "", label: "All" },
              { value: "pa", label: "PA" },
              { value: "multi_state", label: "Multi-state" },
              { value: "national", label: "National" },
            ]}
          />
          <FilterSelect
            label="Line of business"
            value={lob}
            onChange={setLob}
            options={[
              { value: "", label: "All" },
              { value: "medicare", label: "Medicare" },
              { value: "medicaid", label: "Medicaid" },
              { value: "medicaid_mco", label: "Medicaid MCO" },
              { value: "commercial", label: "Commercial" },
              { value: "marketplace", label: "Marketplace" },
              { value: "tricare", label: "TRICARE" },
              { value: "va", label: "VA" },
            ]}
          />
          <FilterSelect
            label="Active"
            value={active}
            onChange={(v) => setActive(v as typeof active)}
            options={[
              { value: "true", label: "Active" },
              { value: "false", label: "Inactive" },
              { value: "", label: "Either" },
            ]}
          />
        </div>
      </Card>

      <Card>
        {isPending ? (
          <Spinner label="Loading payers…" />
        ) : (data?.payerProfiles.length ?? 0) === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No payers match.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Name</th>
                  <th className="p-3">Region</th>
                  <th className="p-3">LOB</th>
                  <th className="p-3">Office Ally ID</th>
                  <th className="p-3">Claim format</th>
                  <th className="p-3">PA req?</th>
                  <th className="p-3">Active</th>
                </tr>
              </thead>
              <tbody>
                {(data?.payerProfiles ?? []).map((p) => (
                  <PayerRow key={p.id} p={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function PayerRow({ p }: { p: PayerProfile }) {
  return (
    <tr className="border-t" style={{ borderColor: "hsl(var(--line-1))" }}>
      <td className="p-3">
        <p
          className="font-medium"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {p.displayName}
        </p>
        <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
          {p.payerLegalName} · {p.slug}
        </p>
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.region}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.lineOfBusiness}
      </td>
      <td
        className="p-3 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {p.officeAllyPayerId ?? p.edi5010PayerId ?? "—"}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {p.claimFormat}
        {p.paperOnly && (
          <span
            className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase"
            style={{
              backgroundColor: "rgba(180, 83, 9, 0.16)",
              color: "#b45309",
            }}
          >
            paper
          </span>
        )}
      </td>
      <td className="p-3 text-center">
        {p.requiresPriorAuthDme ? (
          <span style={{ color: "#b45309" }}>yes</span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>no</span>
        )}
      </td>
      <td className="p-3">
        {p.isActive ? (
          <span style={{ color: "#15803d" }}>active</span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>inactive</span>
        )}
      </td>
    </tr>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span
        className="text-xs font-semibold block mb-1"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded border border-slate-300 px-2 py-1.5 text-sm"
      />
    </label>
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
