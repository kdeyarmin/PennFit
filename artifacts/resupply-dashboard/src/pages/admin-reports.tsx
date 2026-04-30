// /admin/reports — CSV downloads for ops + finance.
//
// Two reports today (orders, returns), date-bounded. Each is a
// direct browser-side <a download> on the API endpoint so the
// browser handles the file save without a JS fetch loop. Auth
// rides on the existing Clerk session cookie.

import { useState } from "react";

const DEFAULT_DAYS_BACK = 30;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function AdminReportsPage() {
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - DEFAULT_DAYS_BACK * 86400_000);
  const [from, setFrom] = useState(isoDate(defaultFrom));
  const [to, setTo] = useState(isoDate(today));

  const ordersUrl = `/resupply-api/admin/reports/orders.csv?from=${from}&to=${to}`;
  const returnsUrl = `/resupply-api/admin/reports/returns.csv?from=${from}&to=${to}`;

  return (
    <div className="space-y-6 max-w-3xl" data-testid="admin-reports-page">
      <header className="space-y-1">
        <h1
          className="text-2xl font-bold tracking-tight"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Reports
        </h1>
        <p className="text-sm text-slate-600">
          CSV downloads for ops and finance reconciliation. Pick a date
          range (max 90 days per export) and click a report.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              From
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              max={to}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-from"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              To
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              min={from}
              max={isoDate(today)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
              data-testid="reports-to"
            />
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <ReportCard
          title="Cash-pay orders"
          subtitle="Stripe checkout sessions in the date range, including payment + shipping state."
          href={ordersUrl}
          testId="reports-orders-link"
        />
        <ReportCard
          title="Returns / RMAs"
          subtitle="Comfort-guarantee returns initiated in the date range, with resolution + refund details."
          href={returnsUrl}
          testId="reports-returns-link"
        />
      </section>
    </div>
  );
}

function ReportCard({
  title,
  subtitle,
  href,
  testId,
}: {
  title: string;
  subtitle: string;
  href: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <p className="text-xs text-slate-600 mt-0.5">{subtitle}</p>
      </div>
      <a
        href={href}
        download
        className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        data-testid={testId}
      >
        Download CSV
      </a>
    </div>
  );
}
