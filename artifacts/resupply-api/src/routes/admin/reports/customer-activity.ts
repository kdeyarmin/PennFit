// reports/customer-activity.ts — the `customer-activity` report:
// aggregated storefront customer activity per day (new signups,
// returning-customer orders, active-customer count). CSV / PDF only
// (no QuickBooks exports — it's a behavioral aggregate, not a
// financial ledger), plus the matching email-attachment builders.
//
// PHI/PII posture: we never serialise an individual customer row;
// the export is the COUNT of new signups, the COUNT of orders from
// already-existing customers, and the running active-customer
// count. Even at the storefront tier (where rows aren't HIPAA-
// protected) this keeps the export safe to email and to leave
// open on a screen during a meeting.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { renderTablePdf } from "../../../lib/report-pdf";
import { requirePermission } from "../../../middlewares/requireAdmin";
import {
  bufferedRes,
  collectReportRows,
  escapeCsv,
  parseRange,
  practiceName,
  rangeLabel,
  rangeSlug,
  setDownloadHeaders,
  type ReportModule,
  type CsvSink,
  reportOrgId,
} from "./shared";

export interface CustomerActivityByDay {
  day: string;
  newCustomers: number;
  returningCustomerOrders: number;
  totalOrders: number;
}

export async function fetchCustomerActivity(
  orgId: string,
  from: Date,
  to: Date,
): Promise<CustomerActivityByDay[]> {
  const supabase = getOrgScopedClient(orgId);

  // Every order in range. We classify "returning vs new" by
  // comparing the order's created_at against the customer's
  // shop_customers.created_at: same-day == first-order, else
  // returning. This is a slightly conservative classifier — a
  // customer who signs up + orders the same day counts as new,
  // even though they did place an order — but it matches operator
  // intuition for the "new-customer cohort" tile.
  // PAGINATED — a plain `.limit(10_000)` is silently re-capped to the
  // PostgREST server row limit (commonly 1000), so a busy tenant's per-day
  // new/returning split would be computed over a truncated order set. Page
  // past the cap.
  const orders = await collectReportRows<{
    customer_id: string | null;
    created_at: string;
  }>((lo, hi) =>
    supabase
      .from("shop_orders")
      .select("customer_id, created_at")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString())
      .not("customer_id", "is", null)
      .order("created_at", { ascending: true })
      .order("customer_id", { ascending: true })
      .range(lo, hi),
  );

  // Collect unique customer IDs from orders in the range.
  const relevantCustomerIds = new Set<string>();
  for (const o of orders) {
    if (o.customer_id) relevantCustomerIds.add(o.customer_id);
  }

  // Fetch earliest created_at for all customers relevant to this
  // report, regardless of whether they were created within [from,to].
  // This ensures we correctly classify returning customers who signed
  // up before the report period. CHUNKED — a large `.in()` list would both
  // exceed the URL length and the ~1000-row cap.
  const firstSeenByCustomer = new Map<string, string>();
  const relevantIdList = Array.from(relevantCustomerIds);
  const CUSTOMER_ID_CHUNK = 300;
  for (let i = 0; i < relevantIdList.length; i += CUSTOMER_ID_CHUNK) {
    const idChunk = relevantIdList.slice(i, i + CUSTOMER_ID_CHUNK);
    const chunkRows = await collectReportRows<{
      customer_id: string | null;
      created_at: string;
    }>((lo, hi) =>
      supabase
        .from("shop_customers")
        .select("customer_id, created_at")
        .in("customer_id", idChunk)
        .order("customer_id", { ascending: true })
        .range(lo, hi),
    );
    for (const c of chunkRows) {
      if (c.customer_id) firstSeenByCustomer.set(c.customer_id, c.created_at);
    }
  }

  // New signups bucketed by day. shop_customers.created_at is the
  // first time we saw the email — opting in elsewhere (sign-up,
  // first cash-pay checkout) all funnel through the same row, so
  // a count by created_at is a clean "new customers per day".
  const signups = await collectReportRows<{
    customer_id: string | null;
    created_at: string;
  }>((lo, hi) =>
    supabase
      .from("shop_customers")
      .select("customer_id, created_at")
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString())
      .order("created_at", { ascending: true })
      .order("customer_id", { ascending: true })
      .range(lo, hi),
  );

  const byDay = new Map<
    string,
    {
      newCustomers: number;
      returningCustomerOrders: number;
      totalOrders: number;
    }
  >();
  function bucket(day: string) {
    let v = byDay.get(day);
    if (!v) {
      v = {
        newCustomers: 0,
        returningCustomerOrders: 0,
        totalOrders: 0,
      };
      byDay.set(day, v);
    }
    return v;
  }

  for (const s of signups ?? []) {
    bucket(s.created_at.slice(0, 10)).newCustomers += 1;
  }
  for (const o of orders ?? []) {
    const day = o.created_at.slice(0, 10);
    const b = bucket(day);
    b.totalOrders += 1;
    const firstSeen = o.customer_id
      ? (firstSeenByCustomer.get(o.customer_id) ?? null)
      : null;
    // If we have no record of the customer's first-seen date OR the
    // first-seen is BEFORE this order's day, this order is from a
    // returning customer. Same-day signup+order counts as new (see
    // the classifier note above).
    if (firstSeen && firstSeen.slice(0, 10) < day) {
      b.returningCustomerOrders += 1;
    }
  }

  return Array.from(byDay.entries())
    .map(([day, v]) => ({ day, ...v }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export function writeCustomerActivityCsv(
  res: CsvSink,
  rows: CustomerActivityByDay[],
): void {
  const headers = [
    "day",
    "new_customers",
    "returning_customer_orders",
    "total_orders",
  ];
  res.write(headers.join(",") + "\n");
  for (const r of rows) {
    res.write(
      [r.day, r.newCustomers, r.returningCustomerOrders, r.totalOrders]
        .map(escapeCsv)
        .join(",") + "\n",
    );
  }
  res.end();
}

export const customerActivityReport: ReportModule = {
  slug: "customer-activity",

  // ─────────────────────────────────────────────────────────────────
  // CUSTOMER ACTIVITY — CSV / PDF only.
  //
  // No QuickBooks exports here on purpose: this report is a behavioral
  // aggregate (signup + order counts per day), not a financial ledger.
  // Operators wanting to feed the underlying transactions into
  // QuickBooks use the `orders` report — that's where the per-order
  // cash receipt lives.
  // ─────────────────────────────────────────────────────────────────
  register(router) {
    router.get(
      "/admin/reports/customer-activity.csv",
      requirePermission("reports.read"),
      async (req, res) => {
        const orgId = reportOrgId(req, res);
        if (!orgId) return;
        const { from, to } = parseRange(req);
        const rows = await fetchCustomerActivity(orgId, from, to);
        setDownloadHeaders(
          res,
          "text/csv; charset=utf-8",
          `pennpaps-customer-activity-${rangeSlug(from, to)}.csv`,
        );
        writeCustomerActivityCsv(res, rows);
      },
    );

    router.get(
      "/admin/reports/customer-activity.pdf",
      requirePermission("reports.read"),
      async (req, res) => {
        const orgId = reportOrgId(req, res);
        if (!orgId) return;
        const { from, to } = parseRange(req);
        const rows = await fetchCustomerActivity(orgId, from, to);
        const totals = rows.reduce(
          (acc, r) => ({
            newCustomers: acc.newCustomers + r.newCustomers,
            returningCustomerOrders:
              acc.returningCustomerOrders + r.returningCustomerOrders,
            totalOrders: acc.totalOrders + r.totalOrders,
          }),
          { newCustomers: 0, returningCustomerOrders: 0, totalOrders: 0 },
        );
        const pdf = await renderTablePdf({
          title: "Customer activity",
          range: rangeLabel(from, to),
          practiceName: practiceName(),
          columns: [
            { label: "Day", width: 100 },
            { label: "New customers", width: 140, rightAlign: true },
            {
              label: "Returning-customer orders",
              width: 200,
              rightAlign: true,
            },
            { label: "Total orders", width: 130, rightAlign: true },
          ],
          rows: rows.map((r) => [
            r.day,
            String(r.newCustomers),
            String(r.returningCustomerOrders),
            String(r.totalOrders),
          ]),
          summaryLines: [
            `New customers in range: ${totals.newCustomers}`,
            `Orders from returning customers: ${totals.returningCustomerOrders}`,
            `Total orders in range: ${totals.totalOrders}`,
            totals.totalOrders > 0
              ? `Returning-customer share: ${(
                  (totals.returningCustomerOrders / totals.totalOrders) *
                  100
                ).toFixed(1)}%`
              : "Returning-customer share: n/a (no orders)",
          ],
        });
        setDownloadHeaders(
          res,
          "application/pdf",
          `pennpaps-customer-activity-${rangeSlug(from, to)}.pdf`,
        );
        res.setHeader("Content-Length", String(pdf.length));
        res.end(pdf);
      },
    );
  },

  async buildEmailCsv(orgId, from, to) {
    const { res, collect } = bufferedRes();
    writeCustomerActivityCsv(res, await fetchCustomerActivity(orgId, from, to));
    return collect();
  },

  async buildEmailPdf(orgId, from, to) {
    const rows = await fetchCustomerActivity(orgId, from, to);
    const totals = rows.reduce(
      (acc, r) => ({
        newCustomers: acc.newCustomers + r.newCustomers,
        returningCustomerOrders:
          acc.returningCustomerOrders + r.returningCustomerOrders,
        totalOrders: acc.totalOrders + r.totalOrders,
      }),
      { newCustomers: 0, returningCustomerOrders: 0, totalOrders: 0 },
    );
    const pdf = await renderTablePdf({
      title: "Customer activity",
      range: rangeLabel(from, to),
      practiceName: practiceName(),
      columns: [
        { label: "Day", width: 100 },
        { label: "New customers", width: 140, rightAlign: true },
        {
          label: "Returning-customer orders",
          width: 200,
          rightAlign: true,
        },
        { label: "Total orders", width: 130, rightAlign: true },
      ],
      rows: rows.map((r) => [
        r.day,
        String(r.newCustomers),
        String(r.returningCustomerOrders),
        String(r.totalOrders),
      ]),
      summaryLines: [
        `New customers in range: ${totals.newCustomers}`,
        `Orders from returning customers: ${totals.returningCustomerOrders}`,
        `Total orders in range: ${totals.totalOrders}`,
        totals.totalOrders > 0
          ? `Returning-customer share: ${(
              (totals.returningCustomerOrders / totals.totalOrders) *
              100
            ).toFixed(1)}%`
          : "Returning-customer share: n/a (no orders)",
      ],
    });
    return pdf;
  },
};
