// /admin/shop/subscriptions/metrics — KPI rollup powering the
// subscription-health dashboard.
//
// One-shot endpoint that returns every counter the dashboard needs
// in a single round-trip. Pure SQL aggregation against the local
// shop_subscriptions mirror — no Stripe round-trips on this path so
// the dashboard is fast even on large customer bases.
//
// Counters returned:
//   activeNow            — status IN ('active','trialing')
//   pausedNow            — status = 'paused'
//   pastDueNow           — status IN ('past_due','unpaid')
//   canceledLifetime     — status IN ('canceled','incomplete_expired')
//   newSubsLast30d       — created_at within last 30 days
//   newSubsLast90d       — created_at within last 90 days
//   canceledLast30d      — canceled_at within last 30 days
//   canceledLast90d      — canceled_at within last 90 days
//   pendingCancellations — cancel_at_period_end = true AND active
//   churnRate30d         — canceledLast30d / (activeNow + canceledLast30d)
//
// Cohort retention (NEW): a 6-month-trailing month-over-month table
// of how many subs created in month X were still active by month Y.
// Surfaced as a flat array of {cohortMonth, totalCreated,
// stillActiveAfterDays} tuples so the dashboard can render the curve.

import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import { getDbPool, shopSubscriptions } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/shop/subscriptions/metrics",
  requireAdmin,
  async (_req, res) => {
    const db = drizzle(getDbPool());

    const [counters] = await db
      .select({
        activeNow: sql<number>`count(*) filter (where ${shopSubscriptions.status} in ('active','trialing'))::int`,
        pausedNow: sql<number>`count(*) filter (where ${shopSubscriptions.status} = 'paused')::int`,
        pastDueNow: sql<number>`count(*) filter (where ${shopSubscriptions.status} in ('past_due','unpaid'))::int`,
        canceledLifetime: sql<number>`count(*) filter (where ${shopSubscriptions.status} in ('canceled','incomplete_expired'))::int`,
        newSubsLast30d: sql<number>`count(*) filter (where ${shopSubscriptions.createdAt} >= now() - interval '30 days')::int`,
        newSubsLast90d: sql<number>`count(*) filter (where ${shopSubscriptions.createdAt} >= now() - interval '90 days')::int`,
        canceledLast30d: sql<number>`count(*) filter (where ${shopSubscriptions.canceledAt} >= now() - interval '30 days')::int`,
        canceledLast90d: sql<number>`count(*) filter (where ${shopSubscriptions.canceledAt} >= now() - interval '90 days')::int`,
        pendingCancellations: sql<number>`count(*) filter (where ${shopSubscriptions.cancelAtPeriodEnd} = true and ${shopSubscriptions.status} in ('active','trialing'))::int`,
      })
      .from(shopSubscriptions);

    const churnDenominator =
      (counters?.activeNow ?? 0) + (counters?.canceledLast30d ?? 0);
    const churnRate30d =
      churnDenominator > 0
        ? (counters!.canceledLast30d / churnDenominator) * 100
        : 0;

    // Cohort: subscriptions created in each of the last 6 calendar
    // months, with how many of THAT cohort are still active today.
    // Useful as a "are new sign-ups churning faster than old ones?"
    // signal.
    const cohortRows = await db.execute(sql`
      with months as (
        select date_trunc('month', now()) - (s.n || ' months')::interval as start
        from generate_series(0, 5) as s(n)
      ),
      starts as (
        select start,
               start + interval '1 month' as next_start
        from months
      )
      select
        to_char(starts.start, 'YYYY-MM') as cohort_month,
        count(${shopSubscriptions.id})::int as total_created,
        count(${shopSubscriptions.id}) filter (
          where ${shopSubscriptions.status} in ('active','trialing','paused','past_due')
        )::int as still_live
      from starts
      left join ${shopSubscriptions}
        on ${shopSubscriptions.createdAt} >= starts.start
        and ${shopSubscriptions.createdAt} <  starts.next_start
      group by starts.start
      order by starts.start asc
    `);
    const cohort = (cohortRows.rows ?? []) as Array<{
      cohort_month: string;
      total_created: number;
      still_live: number;
    }>;

    res.json({
      counters: counters ?? null,
      churnRate30d: Number(churnRate30d.toFixed(2)),
      cohort: cohort.map((r) => ({
        cohortMonth: r.cohort_month,
        totalCreated: r.total_created,
        stillLive: r.still_live,
      })),
    });
  },
);

export default router;
