// GET /admin/analytics/revenue-by-source?days=30        — JSON
// GET /admin/analytics/revenue-by-source.csv?days=30    — CSV
//
// Closed-loop measurement (roadmap Lever 3): a single view of where order
// VOLUME and dollars come from, across the independent channels:
//   * storefront (historical shop) → shop_orders (cash $)
//   * resupply fulfillment         → fulfillments (units) +
//                                    insurance_claims.total_paid_cents
//                                    (ERA payer-paid $, not LTV)
//   * clinical intake form         → public.orders (count only)
//
// Read-only window-bounded aggregation in the established analytics shape
// (route reads, lib/analytics/revenue-by-source.ts reduces). No new
// schema. `reports.read` gated like the sibling analytics routes.
//
// PHI: public.orders carries patient PHI columns, so it is counted
// head-only (no row data pulled). shop_orders / fulfillments / claim
// amount columns here hold no patient names.

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  aggregateRevenueBySource,
  type ClaimPaidRow,
  type FulfillmentRow,
  type ShopOrderRow,
} from "../../lib/analytics/revenue-by-source";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const READ_CAP = 50_000;

// Thrown when the window holds more rows than we read in one page, so the
// aggregate would silently undercount. The route converts it to a clear
// 422 rather than returning wrong totals. (A SQL aggregation RPC would
// remove the cap entirely — tracked as a scale-out follow-up.)
class RevenueWindowTooLargeError extends Error {
  constructor(readonly cap: number) {
    super("revenue_window_too_large");
    this.name = "RevenueWindowTooLargeError";
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

/** Per-page window. A single PostgREST read caps at ~1000 rows
 *  regardless of `.limit()`, so we MUST page to read the full window. */
const PAGE = 1000;

/**
 * Keyset-page a window-bounded read up to READ_CAP rows. Returns the
 * accumulated rows plus the exact total the window matched (from the
 * count header). Stops early once the count proves the window exceeds
 * READ_CAP — the caller turns that into a 422 rather than aggregating a
 * truncated set. Ordered by the stable unique `id` so offset pages don't
 * shift between requests.
 */
async function pageWindow<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown; count: number | null }>,
): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  let total = 0;
  for (let from = 0; from < READ_CAP; from += PAGE) {
    const { data, error, count } = await build(from, from + PAGE - 1);
    if (error) throw error;
    if (count != null) total = count;
    if (!data || data.length === 0) break;
    rows.push(...data);
    // The window is too large to aggregate accurately — stop paging; the
    // caller will reject with a 422 instead of returning wrong totals.
    if (total > READ_CAP) break;
    if (data.length < PAGE) break;
  }
  return { rows, total };
}

async function loadRevenueBySource(cutoff: string, orgId: string) {
  const supabase = getOrgScopedClient(orgId);

  // public.orders is the LEGACY clinical-intake form table (migration 0027).
  // As of migration 0463 it carries org_id, so we count each tenant's OWN
  // intake orders (head-only — the rows hold PHI we never pull).
  const includeClinicalIntake = true;

  const [shop, ful, claims] = await Promise.all([
    pageWindow<ShopOrderRow>((from, to) =>
      supabase
        .from("shop_orders")
        .select("status, amount_total_cents", { count: "exact" })
        .gte("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    pageWindow<FulfillmentRow>((from, to) =>
      supabase
        .from("fulfillments")
        .select("status, quantity", { count: "exact" })
        .gte("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    // ERA remittance dollars — insurance_claims with a paid_at in window.
    // Amounts only (no patient_id / payer free-text in the select list).
    pageWindow<ClaimPaidRow & { id: string }>((from, to) =>
      supabase
        .from("insurance_claims")
        .select("id, total_paid_cents", { count: "exact" })
        .not("paid_at", "is", null)
        .gte("paid_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to),
    ),
  ]);

  // Fail fast rather than silently undercount: if either window matched
  // more rows than the cap we are willing to pull, the aggregate would be
  // incomplete. (Below the cap, pageWindow read EVERY row, so the totals
  // are exact even on busy tenants — the prior single capped read
  // silently truncated at ~1000.)
  if (
    shop.total > READ_CAP ||
    ful.total > READ_CAP ||
    claims.total > READ_CAP
  ) {
    throw new RevenueWindowTooLargeError(READ_CAP);
  }
  const shopRes = { data: shop.rows };
  const fulRes = { data: ful.rows };

  // Head-only count — public.orders holds PHI; we never pull its rows.
  let clinicalFormOrderCount = 0;
  if (includeClinicalIntake) {
    const clinicalRes = await supabase
      .raw()
      .schema("public")
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("created_at", cutoff);
    if (clinicalRes.error) throw clinicalRes.error;
    clinicalFormOrderCount = clinicalRes.count ?? 0;
  }

  return aggregateRevenueBySource({
    shopOrders: (shopRes.data ?? []) as ShopOrderRow[],
    fulfillments: (fulRes.data ?? []) as FulfillmentRow[],
    clinicalFormOrderCount,
    claimPayments: claims.rows.map((r) => ({
      total_paid_cents: r.total_paid_cents,
    })),
  });
}

// Translate the window-too-large sentinel into a 422 the caller can act
// on (reduce `days`). Returns true when it handled the error.
function handleWindowTooLarge(err: unknown, res: Response): boolean {
  if (err instanceof RevenueWindowTooLargeError) {
    res.status(422).json({
      error: "window_too_large",
      message: `Too many records in this window to aggregate accurately (> ${err.cap}). Choose a shorter window.`,
    });
    return true;
  }
  return false;
}

router.get(
  "/admin/analytics/revenue-by-source",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    try {
      const result = await loadRevenueBySource(isoDaysAgo(days), orgId);
      res.json({ windowDays: days, ...result });
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }
  },
);

router.get(
  "/admin/analytics/revenue-by-source.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    let result: Awaited<ReturnType<typeof loadRevenueBySource>>;
    try {
      result = await loadRevenueBySource(isoDaysAgo(days), orgId);
    } catch (err) {
      if (handleWindowTooLarge(err, res)) return;
      throw err;
    }

    const filename = `revenue-by-source-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "source,label,orders,units,paid_orders,cash_revenue_usd,payer_paid_usd\n",
    );
    for (const b of result.bySource) {
      const usd =
        b.cashRevenueCents == null ? "" : (b.cashRevenueCents / 100).toFixed(2);
      const payerUsd =
        b.payerPaidCents == null ? "" : (b.payerPaidCents / 100).toFixed(2);
      res.write(
        `${b.source},${safeCsvCell(b.label)},${b.orders},${
          b.units ?? ""
        },${b.paidOrders ?? ""},${usd},${payerUsd}\n`,
      );
    }
    res.write(
      `total,All sources,${result.totalOrders},,,${(
        result.totalCashRevenueCents / 100
      ).toFixed(2)},${(result.totalPayerPaidCents / 100).toFixed(2)}\n`,
    );
    res.end();
  },
);

export default router;
