// /admin/shop/back-in-stock-queue — admin visibility into the
// "notify me when back in stock" queue introduced alongside the PDP
// notify-me form.
//
// Two endpoints:
//   GET  /admin/shop/back-in-stock-queue
//     Grouped per product. Returns pending count, already-notified
//     count, oldest pending signup. The product name is enriched
//     from the live Stripe catalog when available (preview mode and
//     Stripe-down environments fall back to the bare product id, so
//     the page is still useful in dev).
//   POST /admin/shop/back-in-stock-queue/:productId/dispatch
//     Manual fan-out trigger. Lets ops nudge a queue without going
//     through "edit stock count + save". Reuses the same atomic
//     claim helper as the auto-fanout path.
//
// Auth: requireAdmin (same allowlist as every other /admin/*).

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { projectProduct } from "../../lib/stripe/products-meta";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { dispatchBackInStockForProduct } from "../../lib/back-in-stock-record";

const router: IRouter = Router();

interface QueueRow {
  productId: string;
  productName: string;
  productImageUrl: string | null;
  priceLabel: string | null;
  pendingCount: number;
  notifiedCount: number;
  deliveredCount: number;
  oldestPendingAt: string | null;
  lastNotifiedAt: string | null;
}

router.get(
  "/admin/shop/back-in-stock-queue",
  // Read view of the back-in-stock notification queue —
  // operational inventory data.
  requirePermission("inventory.read"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // Per-product aggregation (pending / notified / delivered counts +
    // oldest-pending + last-notified), top 200 by pending desc then
    // oldest-pending asc, is computed server-side by the
    // resupply.shop_back_in_stock_queue RPC (migration 0164). Postgres
    // runs the COUNT(*) FILTER aggregates over the indexed table and
    // returns ≤200 grouped rows instead of streaming up to 10k
    // notification rows into Node for a JS reduce + sort.
    const { data: aggRows, error: notifErr } = await supabase
      .schema("resupply")
      .rpc("shop_back_in_stock_queue");
    if (notifErr) throw notifErr;

    // PostgREST serializes bigint as string; coerce the counts. The
    // RPC already sorted + limited, so the route just maps the shape.
    // Type the rows explicitly — the rpc() data generic doesn't always
    // resolve through the schema-scoped client.
    type QueueAggRow = {
      product_id: string;
      pending_count: number | string;
      notified_count: number | string;
      delivered_count: number | string;
      oldest_pending_at: string | null;
      last_notified_at: string | null;
    };
    const rows = ((aggRows ?? []) as QueueAggRow[]).map((r) => ({
      productId: r.product_id,
      pendingCount: Number(r.pending_count),
      notifiedCount: Number(r.notified_count),
      deliveredCount: Number(r.delivered_count),
      oldestPendingAt: r.oldest_pending_at,
      lastNotifiedAt: r.last_notified_at,
    }));

    // Enrich with product name + image. We do ONE Stripe list call
    // (the catalog is small and shared with the storefront's 60s
    // cache) instead of N retrieves. If Stripe isn't configured the
    // page still renders — every row just shows the bare product id.
    const cfg = readStripeConfigOrNull();
    const nameById = new Map<
      string,
      {
        name: string;
        imageUrl: string | null;
        priceCents: number | null;
        currency: string | null;
      }
    >();
    if (cfg) {
      try {
        const stripe = getStripeClient(cfg);
        // Page through all active products. The catalog is small
        // (dozens, not thousands) so this is at most 1-3 round trips
        // — but we MUST page rather than `limit: 100` once, otherwise
        // any SKU beyond page 1 falls back to a raw prod_xxx id and
        // the page becomes unusable as the catalog grows. Hard cap
        // at 10 pages (1000 products) as a defense-in-depth bound.
        let startingAfter: string | undefined;
        for (let page = 0; page < 10; page++) {
          const list = await stripe.products.list({
            active: true,
            limit: 100,
            expand: ["data.default_price"],
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          });
          for (const p of list.data) {
            const projected = projectProduct(p);
            if (!projected) continue;
            nameById.set(p.id, {
              name: projected.name,
              imageUrl: projected.imageUrl ?? null,
              priceCents: projected.price?.unitAmount ?? null,
              currency: projected.price?.currency ?? null,
            });
          }
          if (!list.has_more || list.data.length === 0) break;
          startingAfter = list.data[list.data.length - 1]!.id;
        }
      } catch (err) {
        req.log?.warn?.(
          { ...stripeErrLogFields(err) },
          "back-in-stock-queue: Stripe enrichment failed; falling back to ids",
        );
      }
    }

    const enriched: QueueRow[] = rows.map((r) => {
      const meta = nameById.get(r.productId);
      const priceLabel =
        meta && typeof meta.priceCents === "number"
          ? `$${(meta.priceCents / 100).toFixed(2)}`
          : null;
      return {
        productId: r.productId,
        productName: meta?.name ?? r.productId,
        productImageUrl: meta?.imageUrl ?? null,
        priceLabel,
        pendingCount: r.pendingCount,
        notifiedCount: r.notifiedCount,
        deliveredCount: r.deliveredCount,
        oldestPendingAt: r.oldestPendingAt,
        lastNotifiedAt: r.lastNotifiedAt,
      };
    });

    const totals = enriched.reduce(
      (acc, r) => {
        acc.pending += r.pendingCount;
        acc.notified += r.notifiedCount;
        acc.delivered += r.deliveredCount;
        return acc;
      },
      { pending: 0, notified: 0, delivered: 0 },
    );

    res.json({
      queue: enriched,
      totals,
      stripeAvailable: cfg !== null,
    });
  },
);

// Manual fan-out trigger. Ops uses this when they want to push
// notifications out without going through the inventory editor — for
// example after a backorder window closes and stock is already
// non-zero. Same atomic claim semantics as the auto-fanout path; we
// log the result and return the counts so the UI can show "sent N".
router.post(
  "/admin/shop/back-in-stock-queue/:productId/dispatch",
  // Manual fanout — sends notifications to every queued
  // subscriber. Treated as catalog/inventory admin tooling.
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "shop_back_in_stock.send_notifications",
    preset: "bulk",
  }),
  async (req, res) => {
    const productId = String(req.params.productId ?? "");
    if (!/^prod_[A-Za-z0-9_-]+$/.test(productId)) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }

    // Resolve product metadata for the email body. If Stripe isn't
    // configured we can't even render a sensible email subject, so
    // we fail loudly here — silently sending "Item is back in
    // stock at PennPaps" with the bare prod_xxx id would be a worse
    // failure mode than asking ops to set up Stripe first.
    const cfg = readStripeConfigOrNull();
    if (!cfg) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }

    let productName: string;
    let productImageUrl: string | null;
    let priceLabel: string | null;
    try {
      const stripe = getStripeClient(cfg);
      const product = await stripe.products.retrieve(productId, {
        expand: ["default_price"],
      });
      const projected = projectProduct(product);
      if (!projected) {
        res.status(422).json({ error: "unprojectable_product" });
        return;
      }
      productName = projected.name;
      productImageUrl = projected.imageUrl ?? null;
      priceLabel =
        typeof projected.price?.unitAmount === "number"
          ? `$${(projected.price.unitAmount / 100).toFixed(2)}`
          : null;
    } catch (err) {
      req.log?.warn?.(
        {
          productId,
          ...stripeErrLogFields(err),
        },
        "back-in-stock-queue: stripe retrieve failed",
      );
      res.status(404).json({ error: "product_not_found" });
      return;
    }

    const baseUrl =
      process.env.SHOP_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
      "https://pennpaps.com";

    const result = await dispatchBackInStockForProduct({
      productId,
      productName,
      productImageUrl,
      productUrl: `${baseUrl}/shop/p/${encodeURIComponent(productId)}`,
      priceLabel,
    });

    req.log?.info?.(
      {
        productId,
        pending: result.pending,
        attempted: result.attempted,
        delivered: result.delivered,
        failed: result.failed,
      },
      "back-in-stock-queue: manual dispatch complete",
    );

    res.json({
      productId,
      productName,
      pending: result.pending,
      attempted: result.attempted,
      delivered: result.delivered,
      failed: result.failed,
    });
  },
);

export default router;
