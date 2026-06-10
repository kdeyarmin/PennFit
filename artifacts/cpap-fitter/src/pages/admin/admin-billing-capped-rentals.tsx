// /admin/billing/capped-rentals — system-wide 13/36-month rental
// lifecycle tracker. The daily worker advances cycles automatically;
// this page surfaces the state for CSR overrides + audit, and lets
// an admin run the worker on-demand for staging / debugging.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { CalendarClock, Play } from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { csrfHeader } from "@/lib/csrf";
import { formatDateOnly } from "@/lib/utils";

const BASE = "/resupply-api";

type CycleStatus = "active" | "paused" | "transferred" | "cancelled";

interface CappedRentalCycle {
  id: string;
  patient_id: string;
  hcpcs_code: string;
  payer_profile_id: string | null;
  insurance_coverage_id: string | null;
  start_date: string;
  current_month: number;
  max_months: number;
  ownership_transferred_on: string | null;
  status: CycleStatus;
  latest_claim_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface AdvanceStats {
  scanned: number;
  advanced: number;
  transferred: number;
  errored: number;
  byHcpcs: Record<string, number>;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

async function postJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...csrfHeader(),
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

const STATUS_FILTERS: ReadonlyArray<{
  value: "" | CycleStatus;
  label: string;
}> = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "transferred", label: "Transferred" },
  { value: "cancelled", label: "Cancelled" },
  { value: "", label: "All" },
];

function daysToNextAdvance(start: string, currentMonth: number): number {
  // Worker advances when today >= start + (currentMonth * 30 days).
  // Mirrors lib/billing/capped-rental-advancer.ts semantics.
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return Number.NaN;
  const targetMs = startMs + currentMonth * 30 * 24 * 3600 * 1000;
  const deltaDays = (targetMs - Date.now()) / (24 * 3600 * 1000);
  return deltaDays >= 0 ? Math.ceil(deltaDays) : Math.floor(deltaDays);
}

function compliantModifierBucket(c: CappedRentalCycle): string {
  // CMS modifier rotation for CPAP/RAD (E0601 / E0470 / E0471):
  //   months 1-3: KH
  //   months 4-13: KI + KX (when compliant)
  // For other HCPCS we don't claim guidance, just show "—".
  const COMPLIANT_KX = ["E0601", "E0470", "E0471"];
  if (!COMPLIANT_KX.includes(c.hcpcs_code)) return "—";
  if (c.current_month <= 3) return "KH";
  if (c.current_month <= c.max_months) return "KI + KX";
  return "—";
}

export function AdminBillingCappedRentalsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<"" | CycleStatus>("active");

  const cycles = useQuery({
    queryKey: ["admin-capped-rentals", status || "all"],
    queryFn: () =>
      getJSON<{ cycles: CappedRentalCycle[] }>(
        `/admin/capped-rental-cycles${status ? `?status=${status}` : ""}`,
      ),
    staleTime: 60_000,
  });

  const advanceNow = useMutation({
    mutationFn: () =>
      postJSON<{ ok: boolean; stats: AdvanceStats }>(
        "/admin/capped-rental-cycles/advance-now",
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-capped-rentals"] });
    },
  });

  const summary = useMemo(() => {
    const list = cycles.data?.cycles ?? [];
    let activeCount = 0;
    let nearTransfer = 0;
    let nextAdvanceDays: number[] = [];
    for (const c of list) {
      if (c.status === "active") activeCount++;
      if (c.status === "active" && c.current_month >= c.max_months - 1) {
        nearTransfer++;
      }
      if (c.status === "active") {
        const d = daysToNextAdvance(c.start_date, c.current_month);
        if (Number.isFinite(d)) nextAdvanceDays.push(d);
      }
    }
    nextAdvanceDays = nextAdvanceDays.sort((a, b) => a - b);
    const advanceableNow = nextAdvanceDays.filter((d) => d <= 0).length;
    const nextWithinWeek = nextAdvanceDays.filter(
      (d) => d > 0 && d <= 7,
    ).length;
    return { activeCount, nearTransfer, advanceableNow, nextWithinWeek };
  }, [cycles.data]);

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-capped-rentals"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Capped-rental cycles
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          13- and 36-month CMS rental tracking. The advancer worker runs
          nightly; this view surfaces who's where in the cycle and lets an admin
          trigger the advance on-demand.
        </p>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          label="Active cycles"
          value={summary.activeCount}
          isLoading={cycles.isPending}
          tone="navy"
        />
        <KpiCard
          label="Advanceable now"
          value={summary.advanceableNow}
          isLoading={cycles.isPending}
          tone="gold"
          hint="Past 30-day anniversary; worker will pick up tonight"
        />
        <KpiCard
          label="Advance this week"
          value={summary.nextWithinWeek}
          isLoading={cycles.isPending}
          tone="navy"
          hint="Anniversary within 7 days"
        />
        <KpiCard
          label="Near transfer"
          value={summary.nearTransfer}
          isLoading={cycles.isPending}
          tone="gold"
          hint="At penultimate month — ownership lands next cycle"
        />
      </div>

      <Card title="Filters">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Status
            </label>
            <div className="inline-flex rounded-md border overflow-hidden text-xs">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStatus(s.value)}
                  className={`px-3 py-1.5 font-semibold ${
                    status === s.value
                      ? "bg-[hsl(var(--penn-navy))] text-white"
                      : "bg-white"
                  }`}
                  data-testid={`capped-rental-status-${s.value || "all"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="ml-auto flex flex-col items-end gap-1">
            <Button
              intent="primary"
              size="sm"
              disabled={advanceNow.isPending}
              isLoading={advanceNow.isPending}
              onClick={() => advanceNow.mutate()}
              data-testid="capped-rental-advance-now"
            >
              <Play className="h-3.5 w-3.5" />
              {advanceNow.isPending ? "Advancing…" : "Advance now"}
            </Button>
            {advanceNow.data && (
              <p className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
                {advanceNow.data.stats.advanced} advanced ·{" "}
                {advanceNow.data.stats.transferred} transferred ·{" "}
                {advanceNow.data.stats.errored > 0 ? (
                  <span style={{ color: "#b91c1c" }}>
                    {advanceNow.data.stats.errored} errored
                  </span>
                ) : (
                  "no errors"
                )}
              </p>
            )}
          </div>
        </div>
      </Card>

      {cycles.isError && (
        <ErrorPanel
          error={cycles.error}
          onRetry={() => void cycles.refetch()}
        />
      )}

      <Card title="Cycles">
        {cycles.isPending ? (
          <Spinner label="Loading cycles…" />
        ) : (cycles.data?.cycles.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No cycles match the current filter.
          </p>
        ) : (
          <div className="overflow-x-auto -mx-5 -my-5">
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider sticky top-0 bg-white"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="p-3">HCPCS</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Month</th>
                  <th className="p-3">Modifier</th>
                  <th className="p-3">Start</th>
                  <th className="p-3">Next advance</th>
                  <th className="p-3 text-right">Patient</th>
                </tr>
              </thead>
              <tbody>
                {(cycles.data?.cycles ?? []).map((c) => (
                  <CycleRow key={c.id} c={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function CycleRow({ c }: { c: CappedRentalCycle }) {
  const days = daysToNextAdvance(c.start_date, c.current_month);
  const statusTone = (() => {
    switch (c.status) {
      case "active":
        return { color: "#15803d", bg: "rgba(21, 128, 61, 0.10)" };
      case "paused":
        return { color: "#b45309", bg: "rgba(180, 83, 9, 0.10)" };
      case "transferred":
        return { color: "#1d4ed8", bg: "rgba(29, 78, 216, 0.10)" };
      case "cancelled":
        return { color: "hsl(var(--ink-3))", bg: "rgba(0,0,0,0.06)" };
    }
  })();
  const daysTone =
    days <= 0
      ? { color: "#b45309", bg: "rgba(180, 83, 9, 0.12)" }
      : days <= 7
        ? { color: "#1d4ed8", bg: "rgba(29, 78, 216, 0.10)" }
        : { color: "hsl(var(--ink-3))", bg: "rgba(0,0,0,0.04)" };
  return (
    <tr className="border-t" style={{ borderColor: "hsl(var(--line-1))" }}>
      <td
        className="p-3 font-mono font-semibold"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {c.hcpcs_code}
      </td>
      <td className="p-3">
        <span
          className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: statusTone.color, backgroundColor: statusTone.bg }}
        >
          {c.status}
        </span>
      </td>
      <td className="p-3 tabular-nums" style={{ color: "hsl(var(--ink-1))" }}>
        {c.current_month}/{c.max_months}
      </td>
      <td
        className="p-3 font-mono text-[12px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {compliantModifierBucket(c)}
      </td>
      <td className="p-3 text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
        {formatDateOnly(c.start_date)}
      </td>
      <td className="p-3 text-[12px]">
        {c.status === "active" ? (
          <span
            className="inline-block px-2 py-0.5 rounded-full font-semibold tabular-nums"
            style={{ color: daysTone.color, backgroundColor: daysTone.bg }}
          >
            <CalendarClock className="inline h-3 w-3 mr-0.5 -mt-0.5" />
            {days === 0
              ? "today"
              : days < 0
                ? `${Math.abs(days)}d past`
                : `${days}d`}
          </span>
        ) : (
          <span style={{ color: "hsl(var(--ink-3))" }}>—</span>
        )}
      </td>
      <td className="p-3 text-right">
        <Link
          href={`/admin/patients/${c.patient_id}`}
          className="text-xs underline"
          style={{ color: "hsl(var(--penn-navy))" }}
          data-testid={`capped-rental-patient-link-${c.id}`}
        >
          Open
        </Link>
      </td>
    </tr>
  );
}
