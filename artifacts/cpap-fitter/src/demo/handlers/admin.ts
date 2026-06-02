// Admin console handlers. Bootstrap (identity, inbox counts, dashboard
// summary) plus the most prominent worklists and list pages, seeded
// with fictional demo data. The long tail of admin endpoints falls
// through to the router's benign default (empty list / ok) so those
// pages render their empty states rather than erroring.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoAdminIdentity,
  demoInboxCounts,
  demoDashboardSummary,
  demoPatients,
  demoConversations,
  demoEpisodes,
  demoToday,
  demoWorkItems,
  demoFitterLeads,
  demoBillingDirectorSummary,
  demoAdminOrders,
} from "../fixtures/admin";
import { findDemoProduct } from "../fixtures/products";

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
) {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const adminHandlers: DemoHandler[] = [
  // ── bootstrap ────────────────────────────────────────────────────
  route("GET", "/resupply-api/me", () => json(demoAdminIdentity())),
  route("GET", "/resupply-api/admin/inbox-counts", () =>
    json(demoInboxCounts()),
  ),
  route("GET", "/resupply-api/dashboard/summary", () =>
    json(demoDashboardSummary()),
  ),

  // ── worklists ────────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/today", () => json(demoToday())),
  route("GET", "/resupply-api/admin/work-items", () => json(demoWorkItems())),

  // ── core lists (offset/limit pagination) ─────────────────────────
  route("GET", "/resupply-api/patients", (req) =>
    json(demoPatients(intParam(req, "limit", 25), intParam(req, "offset", 0))),
  ),
  route("GET", "/resupply-api/conversations", (req) =>
    json(
      demoConversations(intParam(req, "limit", 25), intParam(req, "offset", 0)),
    ),
  ),
  route("GET", "/resupply-api/episodes", (req) =>
    json(demoEpisodes(intParam(req, "limit", 25), intParam(req, "offset", 0))),
  ),

  // ── leads + billing + orders ─────────────────────────────────────
  route("GET", "/resupply-api/admin/fitter-leads", () =>
    json(demoFitterLeads()),
  ),
  route("GET", "/resupply-api/admin/billing/director-summary", () =>
    json(demoBillingDirectorSummary()),
  ),
  route("GET", "/api/admin/orders", (req) =>
    json(
      demoAdminOrders(intParam(req, "page", 1), intParam(req, "pageSize", 25)),
    ),
  ),

  // ── inventory mutations (admin maps the storefront catalog) ──────
  // The client (shop-inventory-api.ts) reads `json.product.{id,name,
  // category,price.unitAmount,price.currency,stockCount,
  // lowStockThreshold}`, so the response MUST be wrapped in
  // `{ product: <ShopProductView> }`, mirroring the real API.
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/stock",
    (req, { id }) => {
      const body = req.json<{ stockCount?: number | null }>() ?? {};
      return json({
        product: inventoryProduct(id, { stockCount: body.stockCount ?? null }),
      });
    },
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/threshold",
    (req, { id }) => {
      const body = req.json<{ lowStockThreshold?: number | null }>() ?? {};
      return json({
        product: inventoryProduct(id, {
          lowStockThreshold: body.lowStockThreshold ?? null,
        }),
      });
    },
  ),
];

/**
 * Build the `{ product }` payload the inventory client expects after a
 * stock/threshold PATCH. Starts from the seeded catalog product (a
 * full ShopProductView, so `price.unitAmount` etc. are present) and
 * applies the edited field.
 */
function inventoryProduct(
  id: string,
  patch: { stockCount?: number | null; lowStockThreshold?: number | null },
) {
  const p = findDemoProduct(id);
  if (p) return { ...p, ...patch };
  return {
    id,
    name: "Demo product",
    category: "accessory" as const,
    price: { id: `demo_price_${id}`, unitAmount: 0, currency: "usd" },
    stockCount: patch.stockCount ?? null,
    lowStockThreshold: patch.lowStockThreshold ?? null,
  };
}
