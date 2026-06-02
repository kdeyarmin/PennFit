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
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/stock",
    (req, { id }) => {
      const body = req.json<{ stockCount?: number | null }>() ?? {};
      const p = findDemoProduct(id);
      return json({
        id,
        name: p?.name ?? "Demo product",
        category: p?.category ?? "accessory",
        priceCents: p?.price.unitAmount ?? null,
        currency: p?.price.currency ?? "usd",
        stockCount: body.stockCount ?? null,
        lowStockThreshold: p?.lowStockThreshold ?? null,
      });
    },
  ),
  route(
    "PATCH",
    "/resupply-api/admin/shop/products/:id/threshold",
    (req, { id }) => {
      const body = req.json<{ lowStockThreshold?: number | null }>() ?? {};
      const p = findDemoProduct(id);
      return json({
        id,
        name: p?.name ?? "Demo product",
        category: p?.category ?? "accessory",
        priceCents: p?.price.unitAmount ?? null,
        currency: p?.price.currency ?? "usd",
        stockCount: p?.stockCount ?? null,
        lowStockThreshold: body.lowStockThreshold ?? null,
      });
    },
  ),
];
