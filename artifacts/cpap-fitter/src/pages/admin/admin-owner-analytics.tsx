import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetAdminMe } from "@workspace/api-client-react/admin";
import { captureSessionCacheGuard } from "@workspace/resupply-auth-react";
import { ArrowDownToLine, RefreshCw } from "lucide-react";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  OwnerDrillLink,
  OwnerMetric,
  OwnerSection,
  OwnerTable,
  OwnerTrend,
  ownerCount,
  ownerMoney,
} from "@/components/admin/OwnerAnalyticsPrimitives";
import {
  fetchOwnerAnalytics,
  type OwnerAnalyticsPeriod,
  type OwnerAnalyticsResponse,
} from "@/lib/admin/owner-analytics-api";
import {
  ownerAnalyticsCsv,
  ownerDateRangeError,
  ownerLabel,
} from "@/lib/admin/owner-analytics-report";

const control =
  "min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:cursor-not-allowed disabled:opacity-50";
type Business = Extract<
  OwnerAnalyticsResponse["business"],
  { status: "available" }
>["data"];
type Financial = Extract<
  OwnerAnalyticsResponse["financial"],
  { status: "available" }
>["data"];
const instant = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function AdminOwnerAnalyticsPage() {
  const me = useGetAdminMe();
  if (me.isPending)
    return (
      <div className="admin-root">
        <Spinner label="Checking owner access…" />
      </div>
    );
  if (me.error)
    return (
      <div className="admin-root">
        <ErrorPanel error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  if (
    !me.data?.permissions?.includes("metrics.read") ||
    !me.data.permissions.includes("cost.read")
  )
    return (
      <div
        className="admin-root rounded-xl border border-slate-200 p-6"
        role="alert"
      >
        Owner analytics requires management and financial reporting access.
      </div>
    );
  return (
    <OwnerWorkspace
      key={`${me.data.userId}:${me.data.permissions.join(",")}`}
    />
  );
}

function OwnerWorkspace() {
  const client = useQueryClient();
  const [isSessionCurrent] = useState(() => captureSessionCacheGuard(client));
  const today = new Date().toISOString().slice(0, 10);
  const [period, setPeriod] = useState<OwnerAnalyticsPeriod>({ days: 30 });
  const [mode, setMode] = useState("30");
  const [from, setFrom] = useState(
    new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(today);
  const customError = mode === "custom" ? ownerDateRangeError(from, to) : null;
  const applied =
    mode === "custom"
      ? "from" in period &&
        from === period.from &&
        to === period.to &&
        !customError
      : "days" in period && mode === String(period.days);
  const queryKey = ["admin", "analytics", "owner", period] as const;
  const query = useQuery({
    queryKey,
    enabled: Boolean(applied) && isSessionCurrent(),
    queryFn: async ({ signal }) => {
      if (!isSessionCurrent())
        throw new Error("Your session changed. Reload owner analytics.");
      const isCurrent = captureSessionCacheGuard(client);
      const report = await fetchOwnerAnalytics(period, signal);
      if (!isCurrent())
        throw new Error("Your session changed. Refresh owner analytics.");
      return { report, isCurrent };
    },
    staleTime: 60_000,
    retry: false,
  });
  const snapshot = query.data;
  const report =
    applied && !query.isError && snapshot?.isCurrent() ? snapshot.report : null;
  const hasAvailable =
    report?.business.status === "available" ||
    report?.financial.status === "available";
  const canExport = Boolean(report && hasAvailable && !query.isFetching);
  const retry = () => {
    if (isSessionCurrent() && applied) void query.refetch();
  };
  const download = () => {
    const live = client.getQueryState(queryKey);
    if (
      !canExport ||
      !snapshot?.isCurrent() ||
      live?.fetchStatus !== "idle" ||
      live.status !== "success" ||
      live.data !== snapshot
    )
      return;
    const url = URL.createObjectURL(
      new Blob([ownerAnalyticsCsv(snapshot.report)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `owner-overview-${snapshot.report.generatedAt.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div
      className="admin-root mx-auto max-w-7xl space-y-6 pb-10"
      data-testid="owner-analytics-page"
    >
      <header className="rounded-2xl bg-slate-950 p-6 text-white md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
              CareMetric Breathe · Business insights
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              Owner overview
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
              See business activity, understand recorded financial results, and
              focus your team on the next action.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={`${control} inline-flex items-center gap-2 text-slate-900`}
              disabled={!applied || query.isFetching}
              onClick={retry}
            >
              <RefreshCw size={15} aria-hidden />
              Refresh
            </button>
            <button
              type="button"
              className={`${control} inline-flex items-center gap-2 text-slate-900`}
              disabled={!canExport}
              onClick={download}
            >
              <ArrowDownToLine size={15} aria-hidden />
              Download overview CSV
            </button>
          </div>
        </div>
      </header>
      <section
        aria-label="Reporting period"
        className="rounded-xl border border-slate-200 bg-white p-4"
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs font-semibold text-slate-600">
            Reporting period
            <select
              aria-label="Reporting period"
              value={mode}
              className={control}
              onChange={(e) => {
                setMode(e.target.value);
                if (e.target.value !== "custom")
                  setPeriod({
                    days: Number(e.target.value) as 7 | 30 | 90 | 365,
                  });
              }}
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 365 days</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          {mode === "custom" && (
            <>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                Start date (UTC)
                <input
                  type="date"
                  value={from}
                  max={today}
                  className={control}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-semibold text-slate-600">
                End date (UTC)
                <input
                  type="date"
                  value={to}
                  max={today}
                  className={control}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <button
                type="button"
                className={control}
                disabled={Boolean(customError) || Boolean(applied)}
                onClick={() => {
                  if (!ownerDateRangeError(from, to)) setPeriod({ from, to });
                }}
              >
                Apply dates
              </button>
            </>
          )}
        </div>
        {customError && (
          <p role="alert" className="mt-2 text-sm text-rose-700">
            {customError}
          </p>
        )}
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          All reporting dates use UTC. Custom dates include the selected end
          day; today ends at the report time. Comparisons cover the same elapsed
          duration immediately before this period.
        </p>
      </section>
      {!applied ? (
        <p
          role="status"
          className="rounded-xl bg-slate-100 p-5 text-sm text-slate-600"
        >
          Apply a valid date range to load an overview. The previous overview is
          hidden while dates are being edited.
        </p>
      ) : query.isPending ? (
        <Spinner label="Loading owner overview…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={retry} />
      ) : report ? (
        <>
          <div className="flex flex-wrap justify-between gap-2 text-xs leading-relaxed text-slate-500">
            <p>
              Period: {instant(report.window.from)} –{" "}
              {instant(report.window.to)} UTC
              <br />
              Previous: {instant(report.window.previousFrom)} –{" "}
              {instant(report.window.previousTo)} UTC
            </p>
            <p role="status">
              {query.isFetching
                ? "Refreshing… Export is unavailable until this refresh finishes."
                : `Updated ${instant(report.generatedAt)} UTC`}
            </p>
          </div>
          <nav
            aria-label="Overview sections"
            className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium text-teal-800"
          >
            {[
              ["priorities", "Priorities"],
              ["financial", "Financial activity"],
              ["business", "Patients & orders"],
              ...(report.business.status === "available"
                ? [
                    ["claims", "Claims"],
                    ["products", "Products & stock"],
                    ["outreach", "Outreach"],
                  ]
                : []),
              ["definitions", "Sources & definitions"],
            ].map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="underline underline-offset-4"
              >
                {label}
              </a>
            ))}
          </nav>
          <Priorities report={report} />
          {report.financial.status === "available" ? (
            <FinancialOverview data={report.financial.data} />
          ) : (
            <Unavailable
              id="financial"
              title="Financial activity unavailable"
              message={report.financial.message}
              retry={retry}
              pending={query.isFetching}
            />
          )}
          {report.business.status === "available" ? (
            <BusinessOverview data={report.business.data} />
          ) : (
            <Unavailable
              id="business"
              title="Business activity unavailable"
              message={report.business.message}
              retry={retry}
              pending={query.isFetching}
            />
          )}
          <OwnerSection
            id="definitions"
            title="Sources, coverage & definitions"
            description="Use these distinctions when sharing or comparing this overview."
          >
            <ul className="space-y-3 text-sm leading-relaxed text-slate-600">
              <li>
                <strong>Period activity:</strong> counts and recorded financial
                events inside the displayed time window. Previous values use an
                equal elapsed window.
              </li>
              <li>
                <strong>Current queues and stock:</strong> a snapshot taken now,
                including work created before this reporting period. These are
                not historical balances.
              </li>
              <li>
                <strong>Financial reviews:</strong> revenue and costs explicitly
                recorded against pricing reviews. They are not a complete
                company ledger, bank balance or insurance collections report.
                Refunds and reversals may reduce recorded totals.
              </li>
              <li>
                <strong>Completed-review contribution:</strong> lifetime
                recorded revenue less recorded costs only for completed,
                financially settled bound reviews. Incomplete reviews are
                disclosed separately. This is not company operating profit.
              </li>
              <li>
                <strong>Claims:</strong> billed amounts and payments recorded to
                date, not expected collectible revenue. Claim stages and payer
                comparisons group claims created in the selected period, shown
                at their current status. Aging covers the entire current
                open-claim backlog.
              </li>
              <li>
                <strong>Patients and shipping:</strong> prepared units, shipment
                lines and fulfilled episodes are different measures. A recorded
                shipment does not prove delivery; assumed-shipped episodes are
                reported separately.
              </li>
              <li>
                <strong>Outreach:</strong> message counts by recorded status. A
                message being sent or accepted does not prove delivery, a
                patient response, or a sale.
              </li>
            </ul>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
              <OwnerDrillLink href="/admin/reports">
                Detailed financial exports
              </OwnerDrillLink>
              <OwnerDrillLink href="/admin/analytics">
                Clinical analytics
              </OwnerDrillLink>
              <OwnerDrillLink href="/admin/pricing">
                Pricing & owner planning models
              </OwnerDrillLink>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Detailed reports open with their own filters. Planning models use
              explicit assumptions and do not change these observed results.
            </p>
          </OwnerSection>
        </>
      ) : (
        <p role="status">
          Your session changed. Reload the overview to continue.
        </p>
      )}
    </div>
  );
}

function Unavailable({
  id,
  title,
  message,
  retry,
  pending,
}: {
  id: string;
  title: string;
  message: string;
  retry: () => void;
  pending: boolean;
}) {
  return (
    <OwnerSection id={id} title={title}>
      <div role="alert" className="text-sm text-slate-600">
        <p>{message}</p>
        <p className="mt-2">
          This section is excluded from the export. Available sections remain
          usable.
        </p>
      </div>
      <button
        type="button"
        onClick={retry}
        disabled={pending}
        className={`${control} mt-4`}
      >
        Retry {id === "financial" ? "financial" : "business"} activity
      </button>
    </OwnerSection>
  );
}

function Priorities({ report }: { report: OwnerAnalyticsResponse }) {
  const actions: Array<{
    label: string;
    count: number;
    href: string;
    detail: string;
  }> = [];
  if (report.business.status === "available") {
    const s = report.business.data.snapshot;
    actions.push(
      {
        label: "Address holds",
        count: s.addressHoldEpisodes,
        href: "/admin/alerts",
        detail: "Review delivery details before fulfillment.",
      },
      {
        label: "Overdue patient conversations",
        count: s.overdueSlaConversations,
        href: "/admin/conversations",
        detail: "Prioritize replies beyond your response target.",
      },
      {
        label: "Denied claims",
        count: s.deniedClaims,
        href: "/admin/billing/denials",
        detail: "Review denials and next steps with the billing team.",
      },
      {
        label: "Patients due for resupply",
        count: s.dueResupplyPatients,
        href: "/admin/resupply-calendar",
        detail: "Review eligibility and individual or bulk outreach.",
      },
      {
        label: "Unbilled shipment lines",
        count: s.unbilledShipmentLines,
        href: "/admin/billing",
        detail: "Review completed fulfillment waiting for billing.",
      },
      {
        label: "Expired signing requests",
        count: s.expiredSignatures,
        href: "/admin/fitter/orders",
        detail: "Review or renew eligible order requests.",
      },
      {
        label: "Low-stock products",
        count: s.lowStockProducts,
        href: "/admin/catalog",
        detail: "Check tracked stock and replenishment needs.",
      },
    );
  }
  if (report.financial.status === "available") {
    const f = report.financial.data;
    actions.push(
      {
        label: "Pricing approvals",
        count: f.pricing.pendingApprovals,
        href: "/admin/pricing",
        detail: "Review exceptions and current supporting evidence.",
      },
      {
        label: "Incomplete financial reviews",
        count: f.settled.incompleteOrders,
        href: "/admin/pricing",
        detail: "Complete revenue, costs and reconciliation.",
      },
    );
  }
  const active = actions.filter((a) => a.count > 0);
  return (
    <OwnerSection
      id="priorities"
      title="Where to focus now"
      description="Current operational queues, ordered by patient and business follow-up needs."
    >
      {active.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((a) => (
            <div
              key={a.label}
              className="rounded-xl border border-slate-200 p-4"
            >
              <p className="text-2xl font-semibold tabular-nums">
                {ownerCount(a.count)}
              </p>
              <OwnerDrillLink href={a.href}>{a.label}</OwnerDrillLink>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                {a.detail}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-600">
          {actions.length
            ? "No items in the available priority queues."
            : "Priority queues are unavailable until a report section loads."}
        </p>
      )}
      {(report.business.status !== "available" ||
        report.financial.status !== "available") && (
        <p className="mt-3 text-xs text-amber-800">
          Priorities include only available sections; other queues could not be
          checked.
        </p>
      )}
    </OwnerSection>
  );
}

function FinancialOverview({ data: f }: { data: Financial }) {
  const coverage = f.settled.boundOrders
    ? `${((f.settled.settledOrders / f.settled.boundOrders) * 100).toFixed(1)}%`
    : "Not available — no bound reviews";
  return (
    <div id="financial" className="space-y-6">
      <OwnerSection
        title="Recorded financial activity"
        description="Revenue and cost events recorded against tracked pricing reviews during this period. These event totals are not company profit."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OwnerMetric
            label="Recorded revenue activity"
            value={f.current.revenueCents}
            previous={f.previous.revenueCents}
            money
          />
          <OwnerMetric
            label="Recorded cost activity"
            value={f.current.costCents}
            previous={f.previous.costCents}
            money
          />
          <OwnerMetric
            label="Financial events"
            value={f.current.eventCount}
            previous={f.previous.eventCount}
          />
          <OwnerMetric
            label="Reviews with activity"
            value={f.current.quoteCount}
            previous={f.previous.quoteCount}
          />
        </div>
        <div className="mt-6">
          <OwnerTrend
            title="Recorded revenue and cost trend"
            rows={f.daily.map((r) => ({
              label: r.date,
              first: r.revenueCents,
              second: r.costCents,
            }))}
            series={["Recorded revenue", "Recorded costs"]}
            money
          />
        </div>
      </OwnerSection>
      <div className="grid gap-6 lg:grid-cols-2">
        <OwnerSection
          title="Completed-review contribution"
          description="Lifetime completed bound reviews only; this section does not use the reporting-period filter."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <OwnerMetric
              label="Recorded contribution"
              value={f.settled.contributionCents}
              money
              hint="Completed reviews: recorded revenue less recorded costs."
            />
            <OwnerMetric
              label="Completed reviews"
              value={f.settled.settledOrders}
              hint={`${f.settled.boundOrders} bound reviews · coverage ${coverage}`}
            />
            <OwnerMetric
              label="Completed-review revenue"
              value={f.settled.netRevenueCents}
              money
            />
            <OwnerMetric
              label="Completed-review costs"
              value={f.settled.netCostCents}
              money
            />
          </div>
          <div className="mt-4 rounded-lg bg-amber-50 p-3 text-xs leading-relaxed text-amber-950">
            {ownerCount(f.settled.incompleteOrders)} incomplete reviews are
            excluded from completed contribution.{" "}
            {ownerCount(f.settled.costsIncompleteOrders)} have incomplete costs;{" "}
            {ownerCount(f.settled.revenueIncompleteOrders)} have incomplete
            revenue; {ownerCount(f.settled.uncertainOrders)} have uncertain
            events. These groups can overlap.
          </div>
          <OwnerDrillLink href="/admin/pricing">
            Review pricing actuals and evidence
          </OwnerDrillLink>
        </OwnerSection>
        <OwnerSection
          title="Costs & financial data quality"
          description="Recorded cost sources for this period; missing events cannot be inferred."
        >
          <OwnerTable
            label="Recorded cost sources"
            columns={["Source", "Recorded costs", "Events"]}
            rows={f.costSources.map((r) => ({
              key: r.source,
              cells: [
                ownerLabel(r.source),
                ownerMoney(r.costCents),
                ownerCount(r.eventCount),
              ],
            }))}
          />
          <p className="mt-4 text-sm text-slate-600">
            {ownerCount(f.quality.undatedEvents)} events have no usable date;{" "}
            {ownerCount(f.quality.futureDatedEvents)} are future-dated. They are
            excluded from period activity.
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <dt>Pricing policy</dt>
            <dd>
              {f.pricing.policyConfigured ? "Configured" : "Not configured"}
            </dd>
            <dt>Pricing enabled</dt>
            <dd>{f.pricing.enabled ? "Yes" : "No"}</dd>
            <dt>Required order reviews</dt>
            <dd>{f.pricing.enforceQuotes ? "Enforced" : "Optional"}</dd>
            <dt>Published price list</dt>
            <dd>
              {f.pricing.activePriceListConfigured
                ? "Available"
                : "Not configured"}
            </dd>
          </dl>
        </OwnerSection>
      </div>
    </div>
  );
}

function BusinessOverview({ data: b }: { data: Business }) {
  const c = b.current,
    p = b.previous,
    s = b.snapshot;
  const rate = (numerator: number, denominator: number) =>
    denominator
      ? `${((numerator / denominator) * 100).toFixed(1)}%`
      : "Not available";
  return (
    <div id="business" className="space-y-6">
      <OwnerSection
        title="Patients & order activity"
        description="Events in the selected period. Patient counts are distinct within each reporting period."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OwnerMetric
            label="New patients"
            value={c.patientsAdded}
            previous={p.patientsAdded}
          />
          <OwnerMetric
            label="Order requests created"
            value={c.orderRequestsCreated}
            previous={p.orderRequestsCreated}
          />
          <OwnerMetric
            label="Order requests signed"
            value={c.orderRequestsSigned}
            previous={p.orderRequestsSigned}
          />
          <OwnerMetric
            label="Shipment lines recorded"
            value={c.shipmentLinesRecorded}
            previous={p.shipmentLinesRecorded}
          />
          <OwnerMetric
            label="Patients served"
            value={c.patientsServed}
            previous={p.patientsServed}
          />
          <OwnerMetric
            label="Returning patients served"
            value={c.returningPatientsServed}
            previous={p.returningPatientsServed}
            hint={`${rate(c.returningPatientsServed, c.patientsServed)} of patients served; previous ${rate(p.returningPatientsServed, p.patientsServed)}.`}
          />
          <OwnerMetric
            label="Units prepared"
            value={c.unitsQueued}
            previous={p.unitsQueued}
          />
          <OwnerMetric
            label="Fulfilled resupply from period"
            value={c.episodesFulfilled}
            previous={p.episodesFulfilled}
            hint={`Current outcomes of episodes opened in this period. ${ownerCount(c.episodesAssumedShipped)} assumed shipped, reported separately.`}
          />
        </div>
        <div className="mt-6">
          <OwnerTrend
            title="Order request trend"
            rows={b.daily.map((r) => ({
              label: r.date,
              first: r.orderRequestsCreated,
              second: r.orderRequestsSigned,
            }))}
            series={["Created requests", "Signed requests"]}
          />
        </div>
      </OwnerSection>
      <div className="grid gap-6 lg:grid-cols-2">
        <OwnerSection
          title="Patient & resupply queues"
          description="Current snapshot, including work opened before this period."
        >
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <OwnerMetric
              label="Active patients"
              value={s.activePatients}
              hint={`${ownerCount(s.pausedPatients)} paused patients.`}
            />
            <OwnerMetric
              label="Due for resupply"
              value={s.dueResupplyPatients}
              hint={`${ownerCount(s.dueSoonResupplyPatients)} scheduled in the next 30 days; coverage eligibility still needs review.`}
            />
            <OwnerMetric
              label="Pending signatures"
              value={s.pendingSignatures}
            />
            <OwnerMetric
              label="Open fitting requests"
              value={s.openFitRequests}
            />
          </div>
          <h3 className="mb-2 mt-5 text-sm font-semibold">
            Current status of episodes opened in this period
          </h3>
          <p className="mb-3 text-xs text-slate-500">
            {ownerCount(c.episodesOpened)} opened;{" "}
            {ownerCount(c.episodesConfirmed)} currently confirmed. Outcomes can
            change after the period ends.
          </p>
          <OwnerTable
            label="Resupply stages for episodes opened in period"
            columns={["Resupply stage", "Episodes"]}
            rows={b.resupplyStages.map((r) => ({
              key: r.status,
              cells: [ownerLabel(r.status), ownerCount(r.count)],
            }))}
          />
          <div className="mt-4 flex flex-wrap gap-4">
            <OwnerDrillLink href="/admin/resupply-calendar">
              Resupply calendar
            </OwnerDrillLink>
            <OwnerDrillLink href="/admin/analytics/order-outcomes">
              Order outcomes
            </OwnerDrillLink>
          </div>
        </OwnerSection>
        <OwnerSection
          title="Order & conversation queues"
          description="Order stages show requests created in the selected period at their current status. Conversation queues are the current backlog."
        >
          <OwnerTable
            label="Order stages for requests created in period"
            columns={["Order status", "Requests"]}
            rows={b.orderRequestStages.map((r) => ({
              key: r.status,
              cells: [ownerLabel(r.status), ownerCount(r.count)],
            }))}
          />
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <OwnerMetric
              label="Open conversations"
              value={s.openConversations}
            />
            <OwnerMetric
              label="Awaiting staff"
              value={s.awaitingStaffConversations}
            />
            <OwnerMetric
              label="Unassigned conversations"
              value={s.unassignedConversations}
            />
            <OwnerMetric
              label="Overdue response targets"
              value={s.overdueSlaConversations}
            />
          </div>
          <OwnerDrillLink href="/admin/conversations">
            Open team inbox
          </OwnerDrillLink>
        </OwnerSection>
      </div>
      <OwnerSection
        id="claims"
        title="Claims & payer activity"
        description="Period amounts group claims created in this period, with payments recorded to date. They are not cash received during this period."
      >
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OwnerMetric
            label="Claims created"
            value={c.claimsCreated}
            previous={p.claimsCreated}
          />
          <OwnerMetric
            label="Billed on these claims"
            value={c.claimBilledCents}
            previous={p.claimBilledCents}
            money
          />
          <OwnerMetric
            label="Paid to date on these claims"
            value={c.claimPaidToDateCents}
            previous={p.claimPaidToDateCents}
            money
          />
          <OwnerMetric
            label="Open claims now"
            value={s.openClaims}
            hint="Current snapshot, across all periods."
          />
        </div>
        <OwnerTable
          label="Payers for claims created in period"
          columns={[
            "Payer",
            "Claims",
            "Billed",
            "Paid to date",
            "Denied claims",
          ]}
          rows={b.payers.map((r) => ({
            key: r.payer,
            cells: [
              r.payer,
              ownerCount(r.claims),
              ownerMoney(r.billedCents),
              ownerMoney(r.paidCents),
              ownerCount(r.deniedClaims),
            ],
          }))}
        />
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Current status of claims created in this period
            </h3>
            <OwnerTable
              label="Stages of claims created in period"
              columns={["Status", "Claims", "Billed", "Paid to date"]}
              rows={b.claimStages.map((r) => ({
                key: r.status,
                cells: [
                  ownerLabel(r.status),
                  ownerCount(r.count),
                  ownerMoney(r.billedCents),
                  ownerMoney(r.paidCents),
                ],
              }))}
            />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              Current open-claim aging
            </h3>
            <OwnerTable
              label="Current open claim aging"
              columns={["Age", "Claims", "Billed", "Paid to date"]}
              rows={b.claimAging.map((r) => ({
                key: r.bucket,
                cells: [
                  {
                    "0_30": "0–30 days",
                    "31_60": "31–60 days",
                    "61_90": "61–90 days",
                    over_90: "Over 90 days",
                  }[r.bucket],
                  ownerCount(r.count),
                  ownerMoney(r.billedCents),
                  ownerMoney(r.paidCents),
                ],
              }))}
            />
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          <OwnerDrillLink href="/admin/billing">Billing hub</OwnerDrillLink>
          <OwnerDrillLink href="/admin/billing/payer-profitability">
            Payer profitability
          </OwnerDrillLink>
        </div>
      </OwnerSection>
      <div className="grid gap-6 lg:grid-cols-2">
        <OwnerSection
          id="products"
          title="Products & fulfillment"
          description="Top 10 products by units with a recorded shipment in the selected period. This is not product revenue, margin or proof of delivery."
        >
          <OwnerTable
            label="Top products by units shipped"
            columns={["Product", "Units", "Fulfillment lines"]}
            rows={b.topProducts.map((r) => ({
              key: r.sku,
              cells: [
                <span key={r.sku} className="break-words">
                  {r.name ?? r.sku}
                  <span className="block text-xs text-slate-500">{r.sku}</span>
                </span>,
                ownerCount(r.units),
                ownerCount(r.fulfillmentLines),
              ],
            }))}
          />
          <OwnerDrillLink href="/admin/analytics/inventory-turnover">
            Inventory turnover report
          </OwnerDrillLink>
        </OwnerSection>
        <OwnerSection
          title="Stock to review"
          description="Current tracked stock only, with up to 10 low-stock items shown. Supplier availability and untracked items are not assumed to be in stock."
        >
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <OwnerMetric
              label="Out-of-stock products"
              value={s.outOfStockProducts}
            />
            <OwnerMetric
              label="Products with tracked stock"
              value={s.trackedProducts}
              hint={`${ownerCount(s.untrackedProducts)} untracked · ${ownerCount(s.activeProducts)} active products.`}
            />
          </div>
          <OwnerTable
            label="Low stock products"
            columns={["Product", "On hand", "Threshold"]}
            rows={b.lowStock.map((r) => ({
              key: r.sku,
              cells: [
                r.name ? `${r.name} (${r.sku})` : r.sku,
                ownerCount(r.stockCount),
                ownerCount(r.threshold),
              ],
            }))}
          />
          <OwnerDrillLink href="/admin/catalog">
            Review product stock
          </OwnerDrillLink>
        </OwnerSection>
      </div>
      <OwnerSection
        id="outreach"
        title="Outreach & patient response"
        description="Messages created in the selected period, shown with their current recorded delivery status. Delivery and response counts are not conversion rates."
      >
        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <OwnerMetric
            label="Outbound messages"
            value={c.outboundMessages}
            previous={p.outboundMessages}
          />
          <OwnerMetric
            label="Inbound messages"
            value={c.inboundMessages}
            previous={p.inboundMessages}
          />
          <OwnerMetric
            label="Delivered messages"
            value={c.deliveredMessages}
            previous={p.deliveredMessages}
          />
          <OwnerMetric
            label="Failed messages"
            value={c.failedMessages}
            previous={p.failedMessages}
          />
        </div>
        <OwnerTable
          label="Outreach channels"
          columns={["Channel", "Outbound", "Inbound", "Delivered", "Failed"]}
          rows={b.outreachChannels.map((r) => ({
            key: r.channel,
            cells: [
              ownerLabel(r.channel),
              ownerCount(r.outbound),
              ownerCount(r.inbound),
              ownerCount(r.delivered),
              ownerCount(r.failed),
            ],
          }))}
        />
        <div className="mt-4 flex flex-wrap gap-4">
          <OwnerDrillLink href="/admin/analytics/channel-engagement">
            Channel engagement
          </OwnerDrillLink>
          <OwnerDrillLink href="/admin/delivery-failures">
            Delivery failures
          </OwnerDrillLink>
        </div>
      </OwnerSection>
    </div>
  );
}
