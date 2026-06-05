// /admin/therapy-resupply — resupply opportunities from device data.
//
// Reads the vendor `supplies[]` roster the therapy-cloud snapshots
// already cache and surfaces the items whose nextEligibleDate has
// arrived (or is due within a horizon) as a fleet "resupply due" queue.
// High-leak patients whose mask interface is due are flagged as
// combined re-fit + resupply opportunities. Each row links to the
// patient so a CSR can place the order. Exportable to CSV.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Download, PackageCheck, Wind } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge, humanizeStatus } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  getResupplySummary,
  getResupplyOpportunities,
  resupplyOpportunitiesCsvUrl,
  type ResupplyOpportunity,
  type SupplyCategory,
} from "@/lib/admin/therapy-resupply-api";

// Horizon options: 0 = eligible now / overdue; the rest add a "due
// soon" lookahead so a CSR can batch upcoming orders.
const HORIZON_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Due now / overdue" },
  { value: 14, label: "Due within 14 days" },
  { value: 30, label: "Due within 30 days" },
  { value: 60, label: "Due within 60 days" },
];

const CATEGORY_FILTERS: Array<{
  value: SupplyCategory | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "mask", label: "Masks" },
  { value: "cushion", label: "Cushions" },
  { value: "headgear", label: "Headgear" },
  { value: "tubing", label: "Tubing" },
  { value: "filter", label: "Filters" },
  { value: "humidifier_chamber", label: "Humidifier" },
];

const SOURCE_LABELS: Record<string, string> = {
  resmed_airview: "ResMed AirView",
  philips_care: "Philips Care",
  react_health: "React Health",
};

const SUPPLY_NAMES: Record<string, string> = {
  mask: "Mask",
  cushion: "Cushion",
  headgear: "Headgear",
  tubing: "Tubing",
  filter: "Filter",
  humidifier_chamber: "Humidifier chamber",
  other: "Other",
};

export function AdminTherapyResupplyPage() {
  const [dueWithinDays, setDueWithinDays] = useState<number>(0);
  const [category, setCategory] = useState<SupplyCategory | "all">("all");

  const summaryQ = useQuery({
    queryKey: ["admin", "therapy-resupply", "summary", dueWithinDays],
    queryFn: () => getResupplySummary(dueWithinDays),
    refetchOnWindowFocus: false,
  });
  const listQ = useQuery({
    queryKey: ["admin", "therapy-resupply", "list", dueWithinDays, category],
    queryFn: () =>
      getResupplyOpportunities({
        dueWithinDays,
        limit: 200,
        category: category === "all" ? undefined : category,
      }),
    refetchOnWindowFocus: false,
  });

  const s = summaryQ.data?.summary;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PackageCheck className="h-6 w-6" /> Resupply opportunities
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Supplies the manufacturer device data reports as eligible for
            replacement — across ResMed AirView, Philips Care Orchestrator, and
            React Health. High-leak patients whose mask is due are flagged for a
            combined re-fit + resupply.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dueWithinDays}
            onChange={(e) => setDueWithinDays(Number(e.target.value))}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{
              borderColor: "hsl(var(--line-1))",
              backgroundColor: "hsl(var(--surface-1))",
            }}
          >
            {HORIZON_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <a
            href={resupplyOpportunitiesCsvUrl({
              dueWithinDays,
              limit: 200,
              category: category === "all" ? undefined : category,
            })}
            download
          >
            <Button intent="secondary" size="sm">
              <Download className="h-4 w-4" /> Export
            </Button>
          </a>
        </div>
      </header>

      {/* ── KPI tiles ─────────────────────────────────────────────── */}
      {summaryQ.isError ? (
        <ErrorPanel
          error={summaryQ.error}
          onRetry={() => void summaryQ.refetch()}
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            label="Patients w/ items due"
            value={s?.patientsWithDue ?? 0}
            isLoading={summaryQ.isPending}
            hint={`${s?.itemsDue ?? 0} items total`}
          />
          <KpiCard
            label="Overdue items"
            value={s?.itemsOverdue ?? 0}
            isLoading={summaryQ.isPending}
            hint="Past eligible date"
          />
          <KpiCard
            label="Re-fit + resupply"
            value={s?.highLeakRefit ?? 0}
            tone="gold"
            isLoading={summaryQ.isPending}
            hint="High leak + mask/cushion due"
          />
          <KpiCard
            label="Masks due"
            value={s?.byCategory.mask ?? 0}
            isLoading={summaryQ.isPending}
            hint={`${s?.byCategory.cushion ?? 0} cushions · ${
              s?.byCategory.filter ?? 0
            } filters`}
          />
        </div>
      )}

      {/* ── Opportunities list ────────────────────────────────────── */}
      <Card
        title="Items eligible for replacement"
        subtitle="Most-overdue first; high-leak mask interfaces float to the top. Click a patient to place the order."
      >
        <div className="flex flex-wrap gap-2 mb-4">
          {CATEGORY_FILTERS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCategory(c.value)}
              className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
              style={{
                backgroundColor:
                  category === c.value
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--surface-1))",
                color: category === c.value ? "white" : "hsl(var(--ink-2))",
                borderColor:
                  category === c.value
                    ? "hsl(var(--penn-navy))"
                    : "hsl(var(--line-1))",
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        {listQ.isPending ? (
          <Spinner />
        ) : listQ.isError ? (
          <ErrorPanel
            error={listQ.error}
            onRetry={() => void listQ.refetch()}
          />
        ) : listQ.data.opportunities.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No supplies are due in this window. Device-reported rosters are up
            to date.
          </p>
        ) : (
          <OpportunitiesTable opportunities={listQ.data.opportunities} />
        )}
      </Card>
    </div>
  );
}

function OpportunitiesTable({
  opportunities,
}: {
  opportunities: ResupplyOpportunity[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th className="py-2 font-semibold">Patient</th>
            <th className="py-2 font-semibold">Item</th>
            <th className="py-2 font-semibold">Source</th>
            <th className="py-2 font-semibold">Last replaced</th>
            <th className="py-2 font-semibold text-right">Status</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o, i) => (
            <tr
              key={`${o.patientId}-${o.source}-${o.category}-${i}`}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2">
                <Link
                  href={`/admin/patients/${o.patientId}`}
                  className="font-medium hover:underline"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  {o.patientName || o.patientId.slice(0, 8)}
                </Link>
                {o.highLeak && (
                  <span className="ml-2 inline-flex">
                    <Badge variant="warning">
                      <Wind className="h-3 w-3 mr-1" /> High leak
                    </Badge>
                  </span>
                )}
              </td>
              <td className="py-2">
                <span className="font-medium">
                  {SUPPLY_NAMES[o.category] ?? humanizeStatus(o.category)}
                </span>
                {o.description && (
                  <span
                    className="block text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {o.description}
                  </span>
                )}
              </td>
              <td className="py-2 text-xs">
                {SOURCE_LABELS[o.source] ?? o.source}
              </td>
              <td className="py-2 text-xs">{o.lastReplacedDate ?? "—"}</td>
              <td className="py-2 text-right">
                <DueBadge
                  days={o.daysUntilEligible}
                  date={o.nextEligibleDate}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DueBadge({
  days,
  date,
}: {
  days: number | null;
  date: string | null;
}) {
  if (days === null) {
    return <Badge variant="muted">{date ?? "—"}</Badge>;
  }
  if (days < 0) {
    return <Badge variant="danger">{Math.abs(days)}d overdue</Badge>;
  }
  if (days === 0) {
    return <Badge variant="warning">Due today</Badge>;
  }
  return <Badge variant="info">In {days}d</Badge>;
}
