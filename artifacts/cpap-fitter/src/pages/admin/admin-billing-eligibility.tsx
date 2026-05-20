// /admin/billing/eligibility — system-wide eligibility worklist.
//
// The verification team's daily list: every 270/271 round trip the
// system has run in the last N days, with status, payer, financial
// fields, and the "requires prior auth" flag. Rejected and
// transport_failed checks bubble to the top so the team can retry
// or re-key.
//
// Per-patient re-run still lives in the patient detail page; this
// page is the cross-patient queue Brightree / CollaborateMD users
// say they spend an hour in every morning.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, CheckCircle2, ClipboardCheck, ShieldAlert } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchEligibilityRecent,
  formatMoneyCents,
  type EligibilityCheck,
  type EligibilityStatus,
} from "@/lib/admin/billing-api";

const STATUS_FILTERS: ReadonlyArray<{
  value: "" | EligibilityStatus;
  label: string;
}> = [
  { value: "", label: "All" },
  { value: "parsed", label: "Parsed" },
  { value: "submitted", label: "Submitted" },
  { value: "queued", label: "Queued" },
  { value: "rejected", label: "Rejected" },
  { value: "transport_failed", label: "Transport failed" },
];

const WINDOW_OPTIONS = [7, 30, 90] as const;

function statusTone(status: EligibilityStatus): {
  color: string;
  bg: string;
  label: string;
} {
  switch (status) {
    case "parsed":
      return { color: "#15803d", bg: "rgba(21, 128, 61, 0.12)", label: "parsed" };
    case "submitted":
      return { color: "#1d4ed8", bg: "rgba(29, 78, 216, 0.12)", label: "submitted" };
    case "queued":
      return { color: "#b45309", bg: "rgba(180, 83, 9, 0.12)", label: "queued" };
    case "rejected":
      return { color: "#b91c1c", bg: "rgba(185, 28, 28, 0.12)", label: "rejected" };
    case "transport_failed":
      return {
        color: "#b91c1c",
        bg: "rgba(185, 28, 28, 0.12)",
        label: "transport failed",
      };
  }
}

export function AdminBillingEligibilityPage() {
  const [statusFilter, setStatusFilter] = useState<"" | EligibilityStatus>("");
  const [windowDays, setWindowDays] = useState<(typeof WINDOW_OPTIONS)[number]>(
    30,
  );

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: [
      "admin-billing-eligibility-recent",
      statusFilter || "all",
      windowDays,
    ],
    queryFn: () =>
      fetchEligibilityRecent({
        status: statusFilter || undefined,
        days: windowDays,
        limit: 150,
      }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const checks = useMemo(() => data?.checks ?? [], [data]);

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-eligibility"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Eligibility worklist
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Every 270/271 round-trip in the selected window. Rejected
          and transport-failed checks are where the team's time pays
          off — those are coverage rows about to bite us.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <Card title="Filters">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Window
            </label>
            <div className="inline-flex rounded-md border overflow-hidden text-xs">
              {WINDOW_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setWindowDays(d)}
                  className={`px-3 py-1.5 font-semibold ${
                    windowDays === d
                      ? "bg-[hsl(var(--penn-navy))] text-white"
                      : "bg-white"
                  }`}
                  data-testid={`eligibility-window-${d}`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as "" | EligibilityStatus)
              }
              className="rounded-md border px-2 py-1.5 text-sm"
              data-testid="eligibility-status-filter"
            >
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryPill
          icon={<ClipboardCheck className="h-4 w-4" />}
          label="Total in window"
          value={data?.counts.total ?? 0}
          isLoading={isPending}
        />
        <SummaryPill
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Active coverage"
          value={data?.counts.activeCoverage ?? 0}
          isLoading={isPending}
          tone="success"
        />
        <SummaryPill
          icon={<AlertCircle className="h-4 w-4" />}
          label="Inactive / rejected"
          value={
            (data?.counts.inactiveCoverage ?? 0) +
            (data?.counts.byStatus.rejected ?? 0) +
            (data?.counts.byStatus.transport_failed ?? 0)
          }
          isLoading={isPending}
          tone="danger"
        />
        <SummaryPill
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Prior-auth required"
          value={data?.counts.priorAuthFlagged ?? 0}
          isLoading={isPending}
          tone="warning"
        />
      </div>

      <Card
        title="Recent eligibility checks"
        subtitle={`Newest first — ${checks.length} row${checks.length === 1 ? "" : "s"}`}
      >
        {isPending ? (
          <Spinner label="Loading eligibility…" />
        ) : checks.length === 0 ? (
          <p
            className="text-sm py-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            No eligibility checks in this window.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">Status</th>
                  <th className="p-3">Payer</th>
                  <th className="p-3">HCPCS</th>
                  <th className="p-3">Active / In-network</th>
                  <th className="p-3 text-right">Deductible</th>
                  <th className="p-3 text-right">OOP max</th>
                  <th className="p-3 text-right">Coinsurance</th>
                  <th className="p-3">PA?</th>
                  <th className="p-3">Requested</th>
                  <th className="p-3 text-right">Patient</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <EligibilityRow key={c.id} check={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function EligibilityRow({ check }: { check: EligibilityCheck }) {
  const tone = statusTone(check.status);
  return (
    <tr className="border-t" style={{ borderColor: "hsl(var(--line-1))" }}>
      <td className="p-3">
        <span
          className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: tone.color, backgroundColor: tone.bg }}
        >
          {tone.label}
        </span>
        {check.errorMessage && (
          <span
            className="block text-[11px] mt-1"
            style={{ color: "#b91c1c" }}
          >
            {check.errorMessage}
          </span>
        )}
      </td>
      <td
        className="p-3 font-medium"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {check.payerName ?? "—"}
      </td>
      <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
        {check.serviceHcpcs ?? "—"}
      </td>
      <td className="p-3 text-[12px]">
        {check.isActive == null ? (
          <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
        ) : check.isActive ? (
          <span style={{ color: "#15803d" }}>
            active
            {check.inNetwork === true ? " · in-network" : ""}
            {check.inNetwork === false ? " · out-of-network" : ""}
          </span>
        ) : (
          <span style={{ color: "#b91c1c" }}>inactive</span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums">
        <span style={{ color: "hsl(var(--ink-1))" }}>
          {formatMoneyCents(check.deductibleCents)}
        </span>
        {check.deductibleMetCents != null && (
          <span
            className="block text-[10px]"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            met {formatMoneyCents(check.deductibleMetCents)}
          </span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums">
        <span style={{ color: "hsl(var(--ink-1))" }}>
          {formatMoneyCents(check.oopMaxCents)}
        </span>
        {check.oopMetCents != null && (
          <span
            className="block text-[10px]"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            met {formatMoneyCents(check.oopMetCents)}
          </span>
        )}
      </td>
      <td className="p-3 text-right tabular-nums">
        {check.coinsurancePct == null ? "—" : `${check.coinsurancePct}%`}
        {check.copayCents != null && (
          <span
            className="block text-[10px]"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            copay {formatMoneyCents(check.copayCents)}
          </span>
        )}
      </td>
      <td className="p-3">
        {check.requiresPriorAuth === true ? (
          <span
            className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
            style={{
              color: "#b45309",
              backgroundColor: "rgba(180, 83, 9, 0.12)",
            }}
          >
            yes
          </span>
        ) : check.requiresPriorAuth === false ? (
          <span style={{ color: "hsl(var(--ink-3))" }}>no</span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
        )}
      </td>
      <td className="p-3 text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
        <span className="block">
          {new Date(check.requestedAt).toLocaleString()}
        </span>
      </td>
      <td className="p-3 text-right">
        <Link
          href={`/admin/patients/${check.patientId}`}
          className="text-xs underline"
          style={{ color: "hsl(var(--penn-navy))" }}
          data-testid={`eligibility-patient-link-${check.id}`}
        >
          Open
        </Link>
      </td>
    </tr>
  );
}

function SummaryPill({
  icon,
  label,
  value,
  isLoading,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  isLoading: boolean;
  tone?: "default" | "success" | "danger" | "warning";
}) {
  const colors: Record<typeof tone, string> = {
    default: "hsl(var(--ink-1))",
    success: "#15803d",
    danger: "#b91c1c",
    warning: "#b45309",
  };
  return (
    <div className="surface-card p-4">
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1 inline-flex items-center gap-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        <span style={{ color: colors[tone] }}>{icon}</span>
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color: colors[tone] }}
      >
        {isLoading ? (
          <span className="skeleton inline-block h-6 w-10 align-middle" />
        ) : (
          value
        )}
      </p>
    </div>
  );
}
