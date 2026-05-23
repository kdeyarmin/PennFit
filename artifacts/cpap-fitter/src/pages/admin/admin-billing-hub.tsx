// /admin/billing — Billing Hub. Single-pane overview the billing
// director (or AR lead) loads every morning.
//
// Inspired by what Brightree / TIMS / Bonafide users praise the
// loudest: one screen, real numbers, click-through to action.
// Pulls from /admin/billing/director-summary (single round-trip,
// aggregate-only — no PHI), so the page is cheap to refresh.
//
// Six KPI tiles up top, then three sections:
//   1. Work queues — counts that need a human, each linking to the
//      filtered worklist that actually contains the items.
//   2. Money in flight — three dollar totals that materially impact
//      cash flow.
//   3. Denial-rate trend — 30 / 60 / 90 day buckets so the lead can
//      tell trend from noise.
//   4. Top payers by open dollars — where to focus collections.
//
// All deep links use existing /admin/billing/* sub-pages.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  Bot,
  ClipboardCheck,
  ClipboardList,
  DollarSign,
  ListFilter,
  Send,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  Wallet,
} from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchDirectorSummary,
  formatMoneyCents,
  formatPercent,
  type DirectorSummaryResponse,
} from "@/lib/admin/billing-api";

const WINDOW_LABEL: Record<
  DirectorSummaryResponse["denialRateTrend"][number]["window"],
  string
> = {
  d0_30: "Last 30 days",
  d30_60: "30 – 60 days",
  d60_90: "60 – 90 days",
};

export function AdminBillingHubPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-billing-director-summary"],
    queryFn: fetchDirectorSummary,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  const kpis = [
    {
      label: "Stale drafts",
      value: data?.counts.staleDrafts ?? "—",
      hint: "Draft > 24h — submit or close",
      href: "/admin/billing/ai-queue",
      icon: ClipboardList,
      tone: "navy" as const,
    },
    {
      label: "Fresh denials",
      value: data?.counts.freshDenials ?? "—",
      hint: "Last 14 days — need a worker",
      href: "/admin/billing/ai-queue",
      icon: AlertTriangle,
      tone: "gold" as const,
    },
    {
      label: "Submitted, no 999",
      value: data?.counts.stuckSubmittedNoAck ?? "—",
      hint: "Submitted > 48h — chase the clearinghouse",
      href: "/admin/billing/aging",
      icon: Send,
      tone: "navy" as const,
    },
    {
      label: "Auto-resubmit ready",
      value: data?.counts.autoResubmitReady ?? "—",
      hint: "AI-confirmed, one-click resubmit",
      href: "/admin/billing/ai-queue",
      icon: Bot,
      tone: "gold" as const,
    },
    {
      label: "Partial ERAs",
      value: data?.counts.partialEras ?? "—",
      hint: "Need manual claim match",
      href: "/admin/billing/era",
      icon: Wallet,
      tone: "navy" as const,
    },
    {
      label: "Patient $ open",
      value: formatMoneyCents(data?.dollars.patientResponsibilityCents),
      hint: "After payer adjudication — send statement",
      href: "/admin/billing/aging",
      icon: DollarSign,
      tone: "gold" as const,
    },
  ];

  return (
    <div
      className="admin-root space-y-6 max-w-6xl"
      data-testid="admin-billing-hub"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Billing Hub
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Where the billing team starts the day. Real numbers, real
          queues, no PHI — every tile drills into the worklist that
          fixes the problem.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {kpis.map((k) => (
          <Link
            key={k.label}
            href={k.href}
            className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a24a] focus-visible:ring-offset-2 transition-shadow hover:shadow-md"
            data-testid={`billing-kpi-${k.label.replace(/\s+/g, "-").toLowerCase()}`}
          >
            <KpiCard
              label={k.label}
              value={k.value}
              isLoading={isPending}
              hint={k.hint}
              tone={k.tone}
            />
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card
          title="AI work queue"
          subtitle="Scrubber and denial-analyzer output, ready to action"
          action={
            <Link
              href="/admin/billing/ai-queue"
              className="text-xs font-semibold"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              Open queue →
            </Link>
          }
        >
          {isPending ? (
            <Spinner label="Loading AI queue…" />
          ) : (
            <ul className="space-y-2 text-sm">
              <QueueRow
                icon={<AlertTriangle className="h-4 w-4" />}
                label="Scrubber blocked"
                hint="Need a human edit before submit"
                count={data?.counts.scrubBlocking ?? 0}
              />
              <QueueRow
                icon={<Sparkles className="h-4 w-4" />}
                label="Scrubber fixable"
                hint="Suggested patches to apply"
                count={data?.counts.scrubFixable ?? 0}
              />
              <QueueRow
                icon={<ClipboardList className="h-4 w-4" />}
                label="Denials awaiting analysis"
                hint="Run the AI denial analyzer"
                count={data?.counts.deniedNeedsAnalysis ?? 0}
              />
              <QueueRow
                icon={<Bot className="h-4 w-4" />}
                label="Auto-resubmit ready"
                hint="Confidence ≥ threshold, one click"
                count={data?.counts.autoResubmitReady ?? 0}
                tone="gold"
              />
            </ul>
          )}
        </Card>

        <Card
          title="Money in flight"
          subtitle="Open dollars sliced by where they live in the cycle"
        >
          {isPending ? (
            <Spinner label="Loading dollars…" />
          ) : (
            <ul className="space-y-3 text-sm">
              <DollarRow
                label="Submitted, no 999 ack"
                amount={data?.dollars.stuckSubmittedCents ?? 0}
                hint="Clearinghouse hasn't echoed acceptance"
              />
              <DollarRow
                label="Denied — last 14 days"
                amount={data?.dollars.deniedFreshCents ?? 0}
                hint="Reach out or appeal"
              />
              <DollarRow
                label="Patient responsibility — open"
                amount={data?.dollars.patientResponsibilityCents ?? 0}
                hint="Eligible for statement / card-on-file"
              />
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card
          title="Denial rate trend"
          subtitle="Decisions reaching paid / denied / appealed in each window"
          action={
            <Link
              href="/admin/billing/denials"
              className="text-xs font-semibold"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              By payer →
            </Link>
          }
        >
          {isPending ? (
            <Spinner label="Loading trend…" />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-left text-[11px] uppercase tracking-wider"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  <th className="py-1.5">Window</th>
                  <th className="py-1.5 text-right">Decisions</th>
                  <th className="py-1.5 text-right">Denials</th>
                  <th className="py-1.5 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {(data?.denialRateTrend ?? []).map((row) => (
                  <tr
                    key={row.window}
                    className="border-t"
                    style={{ borderColor: "hsl(var(--line-1))" }}
                  >
                    <td className="py-2">{WINDOW_LABEL[row.window]}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.decisions}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row.denials}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatPercent(row.denialRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Top payers by open patient $"
          subtitle="Where statement outreach pays best"
          action={
            <Link
              href="/admin/billing/aging"
              className="text-xs font-semibold"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              Aging by payer →
            </Link>
          }
        >
          {isPending ? (
            <Spinner label="Loading payers…" />
          ) : (data?.topPayersByOpenDollars.length ?? 0) === 0 ? (
            <p
              className="text-sm py-2"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              No open patient balances right now.
            </p>
          ) : (
            <ul className="divide-y" style={{ borderColor: "hsl(var(--line-1))" }}>
              {(data?.topPayersByOpenDollars ?? []).map((p) => (
                <li
                  key={p.payerName}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <span style={{ color: "hsl(var(--ink-1))" }}>
                    {p.payerName || "—"}
                  </span>
                  <span
                    className="tabular-nums font-semibold"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {formatMoneyCents(p.openCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Operational health"
        subtitle="Webhook delivery, surfaced here because billing depends on it"
      >
        {isPending ? (
          <Spinner label="Loading…" />
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <dt
                className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-1"
                style={{ color: "hsl(var(--penn-gold-deep))" }}
              >
                Webhooks queued
              </dt>
              <dd
                className="text-xl font-semibold tabular-nums"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {data?.counts.webhooksQueued ?? 0}
              </dd>
            </div>
            <div>
              <dt
                className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-1"
                style={{ color: "hsl(var(--penn-gold-deep))" }}
              >
                Webhooks exhausted (24h)
              </dt>
              <dd
                className="text-xl font-semibold tabular-nums"
                style={{
                  color:
                    (data?.counts.webhooksExhausted24h ?? 0) > 0
                      ? "#b91c1c"
                      : "hsl(var(--ink-1))",
                }}
              >
                {data?.counts.webhooksExhausted24h ?? 0}
              </dd>
            </div>
            <div>
              <dt
                className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-1"
                style={{ color: "hsl(var(--penn-gold-deep))" }}
              >
                Snapshot taken
              </dt>
              <dd
                className="text-xs"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                {data?.generatedAt
                  ? new Date(data.generatedAt).toLocaleString()
                  : "—"}
              </dd>
            </div>
          </dl>
        )}
      </Card>

      <Card title="Quick links">
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <li>
            <Link
              href="/admin/billing/aging"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <ListFilter className="h-3.5 w-3.5" />
              A/R aging by payer →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/denials"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <TrendingDown className="h-3.5 w-3.5" />
              Denial rate by payer →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/era"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <Wallet className="h-3.5 w-3.5" />
              ERA file upload & history →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/ai-queue"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <Bot className="h-3.5 w-3.5" />
              AI billing queue →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/office-ally"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
              data-testid="billing-hub-link-office-ally"
            >
              <Send className="h-3.5 w-3.5" />
              Office Ally Operations →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/eligibility"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Eligibility worklist →
            </Link>
          </li>
          <li>
            <Link
              href="/admin/billing/prior-auths"
              className="underline inline-flex items-center gap-1.5"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              Prior auth queue (SLA + expiring) →
            </Link>
          </li>
        </ul>
      </Card>
    </div>
  );
}

function QueueRow({
  icon,
  label,
  hint,
  count,
  tone = "navy",
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  count: number;
  tone?: "navy" | "gold";
}) {
  const accent =
    tone === "gold" ? "hsl(var(--penn-gold-deep))" : "hsl(var(--penn-navy))";
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <span className="inline-flex items-center gap-2">
        <span style={{ color: accent }}>{icon}</span>
        <span style={{ color: "hsl(var(--ink-1))" }}>{label}</span>
      </span>
      <span className="text-right">
        <span
          className="text-sm font-semibold tabular-nums"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {count}
        </span>
        <span
          className="block text-[11px] leading-tight"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {hint}
        </span>
      </span>
    </li>
  );
}

function DollarRow({
  label,
  amount,
  hint,
}: {
  label: string;
  amount: number;
  hint: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <div>
        <p
          className="font-medium"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {label}
        </p>
        <p
          className="text-[11px] leading-tight"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {hint}
        </p>
      </div>
      <span
        className="text-lg font-semibold tabular-nums"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {formatMoneyCents(amount)}
      </span>
    </li>
  );
}
