// /admin/analytics — clinical-side analytics dashboard.
//
// Three panels, each independently queried with its own window so a
// CSR can adjust the resupply funnel to 30 days while keeping the
// compliance cohorts on a 180-day horizon.
//
//   1. Resupply funnel — episode lifecycle bar (outreach_pending →
//      fulfilled) plus the terminal drop-out counts.
//   2. Compliance cohorts — adherence rate per signup-month and per
//      payer.
//   3. CSR productivity — per-operator action totals from the audit
//      log, last-active date, top action.
//
// Distinct from /admin/pennpaps/analytics (storefront orders +
// email health + mask popularity).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Download,
  Gauge,
  TrendingUp,
  Users,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  complianceCohortsCsvUrl,
  fetchComplianceCohorts,
  fetchCsrProductivity,
  fetchResupplyFunnel,
  fetchResupplyKpis,
  fetchStuckEpisodes,
  resupplyFunnelCsvUrl,
  type ComplianceCohortsResponse,
  type CsrProductivityResponse,
  type ResupplyFunnelResponse,
  type ResupplyKpisResponse,
  type StuckEpisode,
  type StuckEpisodeStage,
} from "@/lib/admin/analytics-api";

export function AdminAnalyticsPage() {
  const [kpiDays, setKpiDays] = useState(30);
  const [funnelDays, setFunnelDays] = useState(30);
  const [cohortDays, setCohortDays] = useState(180);
  const [productivityDays, setProductivityDays] = useState(14);

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold">Clinical analytics</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Resupply throughput, patient adherence, and CSR productivity for the
          clinical side of the business. Storefront analytics (orders, email,
          mask popularity) live under PennPaps.
        </p>
      </header>

      <KpisPanel days={kpiDays} onDaysChange={setKpiDays} />
      <FunnelPanel days={funnelDays} onDaysChange={setFunnelDays} />
      <StuckEpisodesPanel />
      <CohortsPanel days={cohortDays} onDaysChange={setCohortDays} />
      <ProductivityPanel
        days={productivityDays}
        onDaysChange={setProductivityDays}
      />
    </div>
  );
}

/** A surveyor-friendly inline CSV link rendered on each panel
 *  header. Browser handles the download via the cookie-based
 *  session; the API gates with reports.read. */
function CsvLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors"
      style={{
        backgroundColor: "hsl(var(--line-2))",
        color: "hsl(var(--ink-2))",
      }}
    >
      <Download className="h-3 w-3" />
      {label}
    </a>
  );
}

// ── shared bits ─────────────────────────────────────────────────────

function WindowPicker({
  value,
  onChange,
  options,
}: {
  value: number;
  onChange: (v: number) => void;
  options: number[];
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className="rounded-full px-2.5 py-1 text-xs font-semibold transition-colors"
          style={{
            backgroundColor:
              value === opt ? "hsl(var(--penn-gold))" : "hsl(var(--line-2))",
            color:
              value === opt ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
          }}
        >
          {opt}d
        </button>
      ))}
    </div>
  );
}

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 1000) / 10}%`;
}

// ── Resupply program KPIs ──────────────────────────────────────────

function KpiTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: "hsl(var(--line))" }}
    >
      <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        {label}
      </div>
      <div className="text-xl font-semibold mt-1">{value}</div>
      {hint ? (
        <div className="text-xs mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function KpisBody({ data }: { data: ResupplyKpisResponse }) {
  const opp = data.ordersPerActivePatientAnnualized;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiTile
        label="Connection rate"
        value={pct(data.connectionRate)}
        hint={`${data.respondedCount}/${data.outreachCount} outreach replied`}
      />
      <KpiTile
        label="Confirmation rate"
        value={pct(data.confirmationRate)}
        hint={`${data.confirmedOrders}/${data.totalEpisodes} episodes`}
      />
      <KpiTile
        label="Fulfillment rate"
        value={pct(data.fulfillmentRate)}
        hint={`${data.fulfilledOrders}/${data.confirmedOrders} confirmed`}
      />
      <KpiTile
        label="Orders / active patient / yr"
        value={opp === null ? "—" : opp.toFixed(2)}
        hint={`${data.activePatientCount} active patients`}
      />
      <KpiTile
        label="Items / order"
        value={
          data.itemsPerOrder === null ? "—" : data.itemsPerOrder.toFixed(2)
        }
        hint={`${data.fulfillmentLineItems} items / ${data.ordersWithFulfillments} orders`}
      />
      <KpiTile
        label="Avg order value"
        value={
          data.averageOrderValueCents === null
            ? "—"
            : `$${(data.averageOrderValueCents / 100).toFixed(2)}`
        }
        hint={`${data.paidOrderCount} paid storefront orders`}
      />
      <KpiTile label="Total episodes" value={String(data.totalEpisodes)} />
      <KpiTile label="Confirmed orders" value={String(data.confirmedOrders)} />
      <KpiTile
        label="Patients served"
        value={String(data.uniquePatientsServed)}
      />
      <KpiTile label="Outreach cycles" value={String(data.outreachCount)} />
    </div>
  );
}

function KpisPanel({
  days,
  onDaysChange,
}: {
  days: number;
  onDaysChange: (d: number) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "analytics", "kpis", days],
    queryFn: () => fetchResupplyKpis(days),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Resupply program KPIs
        </span>
      }
      subtitle="Connection, conversion, and fulfillment rates plus orders per patient — the numbers a resupply program is benchmarked on."
      action={
        <WindowPicker
          value={days}
          onChange={onDaysChange}
          options={[7, 30, 90]}
        />
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <KpisBody data={data} />
      )}
    </Card>
  );
}

// ── Resupply funnel ─────────────────────────────────────────────────

function FunnelPanel({
  days,
  onDaysChange,
}: {
  days: number;
  onDaysChange: (d: number) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "analytics", "funnel", days],
    queryFn: () => fetchResupplyFunnel(days),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Gauge className="h-4 w-4" />
          Resupply funnel
        </span>
      }
      subtitle="Episode lifecycle and drop-off counts in the window."
      action={
        <div className="flex items-center gap-2">
          <WindowPicker
            value={days}
            onChange={onDaysChange}
            options={[7, 30, 90]}
          />
          <CsvLink href={resupplyFunnelCsvUrl(days)} label="CSV" />
        </div>
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <FunnelBody data={data} />
      )}
    </Card>
  );
}

// ── Stuck episodes drill-down ──────────────────────────────────────

const STUCK_STAGE_LABEL: Record<StuckEpisodeStage, string> = {
  outreach_pending: "Outreach pending",
  awaiting_response: "Awaiting response",
  confirmed: "Confirmed (not yet fulfilled)",
};

function StuckEpisodesPanel() {
  const [stage, setStage] = useState<StuckEpisodeStage>("awaiting_response");
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "analytics", "stuck", stage],
    queryFn: () => fetchStuckEpisodes(stage),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          Stuck episodes
        </span>
      }
      subtitle="Oldest episodes still sitting in a non-terminal stage. Triage these to clear the funnel."
      action={
        <div className="flex items-center gap-1">
          {(
            [
              "outreach_pending",
              "awaiting_response",
              "confirmed",
            ] as StuckEpisodeStage[]
          ).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStage(s)}
              className="rounded-full px-2.5 py-1 text-xs font-semibold transition-colors"
              style={{
                backgroundColor:
                  stage === s ? "hsl(var(--penn-gold))" : "hsl(var(--line-2))",
                color:
                  stage === s ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
              }}
            >
              {STUCK_STAGE_LABEL[s]}
            </button>
          ))}
        </div>
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.episodes.length === 0 ? (
        <p className="text-sm py-2" style={{ color: "hsl(var(--ink-3))" }}>
          Nothing stuck in this stage. 🎉
        </p>
      ) : (
        <StuckEpisodesTable episodes={data.episodes} />
      )}
    </Card>
  );
}

function StuckEpisodesTable({ episodes }: { episodes: StuckEpisode[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Age</th>
          <th className="py-2 font-semibold">Patient</th>
          <th className="py-2 font-semibold">Payer</th>
          <th className="py-2 font-semibold">Created</th>
          <th className="py-2 font-semibold">Expires</th>
          <th className="py-2 font-semibold"></th>
        </tr>
      </thead>
      <tbody>
        {episodes.map((e) => (
          <tr
            key={e.id}
            className="border-b"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <td
              className="py-1.5 font-mono tabular-nums"
              style={{
                color:
                  e.ageDays >= 7
                    ? "hsl(0 70% 35%)"
                    : e.ageDays >= 3
                      ? "hsl(35 75% 35%)"
                      : "hsl(var(--ink-2))",
              }}
            >
              {e.ageDays}d
            </td>
            <td className="py-1.5">
              {e.patientName ?? (
                <span className="font-mono text-xs text-muted-foreground">
                  {e.patientId.slice(0, 8)}
                </span>
              )}
            </td>
            <td className="py-1.5 text-xs">{e.insurancePayer ?? "—"}</td>
            <td className="py-1.5 text-xs">
              {new Date(e.createdAt).toLocaleDateString()}
            </td>
            <td className="py-1.5 text-xs">
              {e.expiresAt ? new Date(e.expiresAt).toLocaleDateString() : "—"}
            </td>
            <td className="py-1.5 text-right">
              <a
                href={`/admin/patients/${e.patientId}`}
                className="text-xs hover:underline"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                Open →
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const FUNNEL_STAGE_LABEL: Record<string, string> = {
  outreach_pending: "Outreach pending",
  awaiting_response: "Awaiting response",
  confirmed: "Confirmed",
  fulfilled: "Fulfilled",
};

const DROPOUT_LABEL: Record<string, string> = {
  declined: "Declined",
  expired: "Expired",
  canceled: "Canceled",
};

function FunnelBody({ data }: { data: ResupplyFunnelResponse }) {
  const stages: Array<keyof typeof FUNNEL_STAGE_LABEL> = [
    "outreach_pending",
    "awaiting_response",
    "confirmed",
    "fulfilled",
  ];
  const max = Math.max(
    1,
    ...stages.map((s) => data.byStage[s as keyof typeof data.byStage]),
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-6 text-sm">
        <Stat label="Total in window" value={data.total.toLocaleString()} />
        <Stat
          label="Fulfilled"
          value={data.byStage.fulfilled.toLocaleString()}
        />
        <Stat label="Fulfillment rate" value={pct(data.fulfillmentRate)} />
      </div>

      <ul className="space-y-2">
        {stages.map((stage) => {
          const count = data.byStage[stage as keyof typeof data.byStage];
          const widthPct = (count / max) * 100;
          return (
            <li
              key={stage}
              className="grid grid-cols-[160px_1fr_60px] gap-2 items-center text-sm"
            >
              <span style={{ color: "hsl(var(--ink-2))" }}>
                {FUNNEL_STAGE_LABEL[stage]}
              </span>
              <div
                className="h-4 rounded"
                style={{
                  backgroundColor: "hsl(var(--line-2))",
                }}
              >
                <div
                  className="h-4 rounded"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: "hsl(var(--penn-gold))",
                  }}
                />
              </div>
              <span className="text-right tabular-nums font-medium">
                {count.toLocaleString()}
              </span>
            </li>
          );
        })}
      </ul>

      {(data.dropOuts.declined > 0 ||
        data.dropOuts.expired > 0 ||
        data.dropOuts.canceled > 0) && (
        <div
          className="rounded-md border p-3 text-xs"
          style={{
            borderColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-2))",
          }}
        >
          <strong>Drop-outs:</strong>{" "}
          {(["declined", "expired", "canceled"] as const)
            .map((k) => `${DROPOUT_LABEL[k]}: ${data.dropOuts[k]}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
}

// ── Compliance cohorts ──────────────────────────────────────────────

function CohortsPanel({
  days,
  onDaysChange,
}: {
  days: number;
  onDaysChange: (d: number) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "analytics", "cohorts", days],
    queryFn: () => fetchComplianceCohorts(days),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Compliance cohorts
        </span>
      }
      subtitle="Medicare 90-day adherence: % of patients whose best 30-night window hit ≥4 hr on ≥70% of nights."
      action={
        <div className="flex items-center gap-2">
          <WindowPicker
            value={days}
            onChange={onDaysChange}
            options={[90, 180, 365]}
          />
          <CsvLink href={complianceCohortsCsvUrl(days)} label="CSV" />
        </div>
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <CohortsBody data={data} />
      )}
    </Card>
  );
}

function CohortsBody({ data }: { data: ComplianceCohortsResponse }) {
  if (data.byMonth.length === 0) {
    return (
      <p className="text-sm py-2" style={{ color: "hsl(var(--ink-3))" }}>
        No patients onboarded in this window yet.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 text-muted-foreground">
          By signup month
        </h3>
        <CohortTable
          rows={data.byMonth.map((b) => ({
            label: b.cohort,
            total: b.total,
            qualifying: b.qualifying,
            rate: b.rate,
          }))}
        />
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 text-muted-foreground">
          By payer
        </h3>
        <CohortTable
          rows={data.byPayer.map((b) => ({
            label: b.payer,
            total: b.total,
            qualifying: b.qualifying,
            rate: b.rate,
          }))}
        />
      </div>
    </div>
  );
}

function CohortTable({
  rows,
}: {
  rows: Array<{
    label: string;
    total: number;
    qualifying: number;
    rate: number | null;
  }>;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Group</th>
          <th className="py-2 font-semibold text-right">N</th>
          <th className="py-2 font-semibold text-right">Qual.</th>
          <th className="py-2 font-semibold text-right">Rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.label}
            className="border-b"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <td className="py-1.5">{r.label}</td>
            <td className="py-1.5 text-right tabular-nums">{r.total}</td>
            <td className="py-1.5 text-right tabular-nums">{r.qualifying}</td>
            <td
              className="py-1.5 text-right tabular-nums font-medium"
              style={{
                color:
                  r.rate != null && r.rate >= 0.7
                    ? "hsl(var(--success, 142, 70%, 35%))"
                    : "hsl(var(--ink-1))",
              }}
            >
              {pct(r.rate)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── CSR productivity ───────────────────────────────────────────────

function ProductivityPanel({
  days,
  onDaysChange,
}: {
  days: number;
  onDaysChange: (d: number) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "analytics", "productivity", days],
    queryFn: () => fetchCsrProductivity(days),
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Users className="h-4 w-4" />
          CSR productivity
        </span>
      }
      subtitle="Per-operator productive actions from the audit log. Read-only browsing isn't counted."
      action={
        <WindowPicker
          value={days}
          onChange={onDaysChange}
          options={[7, 14, 30]}
        />
      }
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <ProductivityBody data={data} />
      )}
    </Card>
  );
}

function ProductivityBody({ data }: { data: CsrProductivityResponse }) {
  if (data.unavailable) {
    return (
      <p
        className="text-sm py-2"
        style={{ color: "hsl(var(--ink-3))" }}
        data-testid="csr-productivity-unavailable"
      >
        Per-operator productivity is no longer tracked. The underlying audit log
        was retired; this panel will return when a replacement event source is
        wired up.
      </p>
    );
  }
  if (data.rows.length === 0) {
    return (
      <p className="text-sm py-2" style={{ color: "hsl(var(--ink-3))" }}>
        No productive activity in this window.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="text-sm">
        <Stat
          label="Total actions"
          value={data.totalActions.toLocaleString()}
        />
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th className="py-2 font-semibold">Operator</th>
            <th className="py-2 font-semibold text-right">Total</th>
            <th className="py-2 font-semibold">Top action</th>
            <th className="py-2 font-semibold">Last active</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const top = topAction(row.byAction);
            return (
              <tr
                key={row.operator}
                className="border-b"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                <td className="py-1.5 font-mono text-xs">{row.operator}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">
                  {row.total}
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {top ? `${top.action} (${top.count})` : "—"}
                </td>
                <td className="py-1.5 text-xs text-muted-foreground">
                  {row.lastActiveDate ?? "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function topAction(
  byAction: Record<string, number>,
): { action: string; count: number } | null {
  let best: { action: string; count: number } | null = null;
  for (const [action, count] of Object.entries(byAction)) {
    if (!best || count > best.count) best = { action, count };
  }
  return best;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
