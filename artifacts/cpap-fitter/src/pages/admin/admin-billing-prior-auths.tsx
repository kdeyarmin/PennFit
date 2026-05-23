// /admin/billing/prior-auths — system-wide prior-auth queue.
//
// Five buckets, each a card section the team works in order:
//   1. Missed SLA   — past target without a decision (regulator
//                     attention; chase the MCO portal).
//   2. At-risk SLA  — ≤ 2 days remaining (proactive chase).
//   3. Awaiting     — submitted to payer; no decision yet.
//   4. Expiring     — approved, but approved_through ≤ today + 30d
//                     (re-auth before the next dispense).
//   5. Drafts       — captured, not yet submitted.
//
// Rows deep-link to the patient detail page where the existing
// PriorAuthorizationsTab takes over for status transitions.
//
// All counts + dates only — no PHI in the response.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertOctagon,
  AlertTriangle,
  CalendarClock,
  Clock,
  FileEdit,
} from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchPriorAuthQueue,
  type PriorAuthRow,
  type PriorAuthQueueResponse,
} from "@/lib/admin/billing-api";

const EXPIRY_WINDOWS = [14, 30, 60, 90] as const;

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // approved_through is a DATE (YYYY-MM-DD); avoid timezone shift.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-");
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString();
  }
  return new Date(iso).toLocaleDateString();
}

function dayBadge(days: number | null, tone: "danger" | "warning" | "muted") {
  if (days == null) return null;
  const palette = {
    danger: { color: "#b91c1c", bg: "rgba(185, 28, 28, 0.12)" },
    warning: { color: "#b45309", bg: "rgba(180, 83, 9, 0.12)" },
    muted: { color: "hsl(var(--ink-2))", bg: "rgba(0,0,0,0.04)" },
  }[tone];
  const text =
    days < 0
      ? `${Math.abs(days)}d past`
      : days === 0
        ? "today"
        : `${days}d left`;
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums"
      style={{ color: palette.color, backgroundColor: palette.bg }}
    >
      {text}
    </span>
  );
}

export function AdminBillingPriorAuthsPage() {
  const [expiringWithinDays, setExpiringWithinDays] = useState<
    (typeof EXPIRY_WINDOWS)[number]
  >(30);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-billing-prior-auth-queue", expiringWithinDays],
    queryFn: () =>
      fetchPriorAuthQueue({ expiringWithinDays, limit: 100 }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const counts = useMemo<PriorAuthQueueResponse["counts"]>(
    () =>
      data?.counts ?? {
        atRisk: 0,
        missed: 0,
        awaiting: 0,
        expiringSoon: 0,
        drafts: 0,
      },
    [data],
  );

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-prior-auths"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Prior auths
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          PA Medicaid MCOs run a 7-day SLA starting 2026-01-01. The
          sweep job tags each PA every 6 hours; this view shows the
          rows that need a human now. The expiring bucket is your
          best defence against the "we got the order but no PA"
          billing gap.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KpiCard
          label="Missed SLA"
          value={counts.missed}
          isLoading={isPending}
          tone="gold"
          hint="Past target, no decision"
        />
        <KpiCard
          label="At-risk SLA"
          value={counts.atRisk}
          isLoading={isPending}
          tone="gold"
          hint="≤ 2 days remaining"
        />
        <KpiCard
          label="Awaiting"
          value={counts.awaiting}
          isLoading={isPending}
          tone="navy"
          hint="Submitted, no decision"
        />
        <KpiCard
          label="Expiring soon"
          value={counts.expiringSoon}
          isLoading={isPending}
          tone="navy"
          hint={`Approved, lapsing ≤ ${expiringWithinDays}d`}
        />
        <KpiCard
          label="Drafts"
          value={counts.drafts}
          isLoading={isPending}
          tone="navy"
          hint="Captured, not yet submitted"
        />
      </div>

      <Card title="Expiring window">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Expiring within
            </label>
            <div className="inline-flex rounded-md border overflow-hidden text-xs">
              {EXPIRY_WINDOWS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setExpiringWithinDays(d)}
                  className={`px-3 py-1.5 font-semibold ${
                    expiringWithinDays === d
                      ? "bg-[hsl(var(--penn-navy))] text-white"
                      : "bg-white"
                  }`}
                  data-testid={`pa-expiry-${d}`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {isPending ? (
        <Spinner label="Loading prior auths…" />
      ) : (
        <>
          <PaBucket
            title="Missed SLA"
            subtitle="Past target without a decision — call the MCO portal"
            icon={<AlertOctagon className="h-4 w-4" />}
            tone="danger"
            rows={data?.missed ?? []}
            emptyLabel="None missed — keep it that way."
            dateColumn={{
              label: "Target",
              get: (r) => r.mcoSlaTargetDate,
              days: (r) => r.daysToTarget,
              dayTone: "danger",
            }}
          />
          <PaBucket
            title="At-risk SLA"
            subtitle="≤ 2 days remaining on the 7-day Medicaid MCO clock"
            icon={<AlertTriangle className="h-4 w-4" />}
            tone="warning"
            rows={data?.atRisk ?? []}
            emptyLabel="No SLAs at risk."
            dateColumn={{
              label: "Target",
              get: (r) => r.mcoSlaTargetDate,
              days: (r) => r.daysToTarget,
              dayTone: "warning",
            }}
          />
          <PaBucket
            title="Awaiting decision"
            subtitle="Submitted to payer; waiting on a decision"
            icon={<Clock className="h-4 w-4" />}
            tone="info"
            rows={data?.awaiting ?? []}
            emptyLabel="No PAs awaiting payer decision."
            dateColumn={{
              label: "Submitted",
              get: (r) => r.submittedAt,
              days: () => null,
              dayTone: "muted",
            }}
          />
          <PaBucket
            title={`Expiring within ${expiringWithinDays} days`}
            subtitle="Approved auths whose `approved_through` is near — re-auth before the next dispense"
            icon={<CalendarClock className="h-4 w-4" />}
            tone="warning"
            rows={data?.expiringSoon ?? []}
            emptyLabel="No auths expiring in this window."
            dateColumn={{
              label: "Approved through",
              get: (r) => r.approvedThrough,
              days: (r) => r.daysToExpiry,
              dayTone: "warning",
            }}
          />
          <PaBucket
            title="Drafts"
            subtitle="PAs captured but not yet submitted — submit or close"
            icon={<FileEdit className="h-4 w-4" />}
            tone="muted"
            rows={data?.drafts ?? []}
            emptyLabel="No draft PAs hanging around."
            dateColumn={{
              label: "Created",
              get: (r) => r.createdAt,
              days: () => null,
              dayTone: "muted",
            }}
          />
        </>
      )}
    </div>
  );
}

function PaBucket({
  title,
  subtitle,
  icon,
  tone,
  rows,
  emptyLabel,
  dateColumn,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  tone: "danger" | "warning" | "info" | "muted";
  rows: PriorAuthRow[];
  emptyLabel: string;
  dateColumn: {
    label: string;
    get: (r: PriorAuthRow) => string | null;
    days: (r: PriorAuthRow) => number | null;
    dayTone: "danger" | "warning" | "muted";
  };
}) {
  const accent = {
    danger: "#b91c1c",
    warning: "#b45309",
    info: "hsl(var(--penn-navy))",
    muted: "hsl(var(--ink-3))",
  }[tone];

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <span style={{ color: accent }}>{icon}</span>
          {title}
        </span>
      }
      subtitle={subtitle}
      action={
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {rows.length}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p
          className="text-sm py-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {emptyLabel}
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
                <th className="p-3">Status</th>
                <th className="p-3">Auth #</th>
                <th className="p-3">{dateColumn.label}</th>
                <th className="p-3 text-right">Patient</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <td
                    className="p-3 font-medium"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {r.payerName}
                  </td>
                  <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                    {r.hcpcsCode}
                  </td>
                  <td className="p-3">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                      style={{
                        color: "hsl(var(--ink-2))",
                        backgroundColor: "rgba(0,0,0,0.06)",
                      }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="p-3" style={{ color: "hsl(var(--ink-2))" }}>
                    {r.authNumber ?? "—"}
                  </td>
                  <td className="p-3 text-[12px]">
                    <span style={{ color: "hsl(var(--ink-1))" }}>
                      {formatDate(dateColumn.get(r))}
                    </span>
                    <span className="block mt-0.5">
                      {dayBadge(dateColumn.days(r), dateColumn.dayTone)}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <Link
                      href={`/admin/patients/${r.patientId}`}
                      className="text-xs underline"
                      style={{ color: "hsl(var(--penn-navy))" }}
                      data-testid={`pa-patient-link-${r.id}`}
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
