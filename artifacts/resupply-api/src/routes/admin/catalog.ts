// /admin/catalog — the product catalog + warehouse stock.
//
//   GET   /admin/catalog/products             browse / search
//   GET   /admin/catalog/products/:sku        one SKU + recent movements
//   POST  /admin/catalog/products             create or update a SKU
//   POST  /admin/catalog/products/:sku/stock  move stock (audited)
//   GET   /admin/catalog/low-stock            reorder worklist
//
// The catalog used to be the Stripe Products list, with on-hand living in
// `product.metadata.stock_count`. Patients are insurance-only now, so both
// moved to Postgres (migration 0516) — this is the surface that manages
// them. Supplies still ship against a claim, so a DME still needs to know
// what a SKU is and how many are on the shelf.
//
// Permission posture mirrors the inventory pages this replaces:
// `inventory.read` to look, `admin.tools.manage` to change. Stock only
// moves through the adjust RPC, so every change lands in the ledger with an
// actor and a reason.
//
// PHI: none. A SKU, a count, and a staff email are not patient data — but
// the `reference` field can carry a fulfillment id, so it is never logged.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import {
  SUPPLY_CATEGORIES,
  isSupplyCategory,
} from "../../lib/catalog/categories";
import {
  InsufficientStockError,
  UnknownSkuError,
  adjustStock,
  getProduct,
  listLowStock,
  listProducts,
  listStockLedger,
  upsertProduct,
} from "../../lib/catalog/store";
import { logger } from "../../lib/logger";
import { redactDbErr } from "../../lib/redact-db-err";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// A SKU is an operator-typed warehouse identifier. Keep it to characters
// that survive a CSV round-trip to PacWare and a URL path segment.
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const skuParam = z.object({ sku: z.string().regex(SKU_RE) });

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(40).optional(),
  includeInactive: z.coerce.boolean().optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const upsertBody = z
  .object({
    sku: z.string().regex(SKU_RE),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullish(),
    category: z.string().trim().max(40).nullish(),
    manufacturer: z.string().trim().max(120).nullish(),
    modelNumber: z.string().trim().max(120).nullish(),
    unitOfMeasure: z.string().trim().min(1).max(24).optional(),
    lowStockThreshold: z.number().int().min(0).max(1_000_000).nullish(),
    active: z.boolean().optional(),
    // Applies to a NEW SKU only; an existing balance moves via /stock so the
    // change is ledgered.
    openingStock: z.number().int().min(0).max(1_000_000).nullish(),
  })
  .strict();

const stockBody = z
  .object({
    // Signed. Negative dispenses; the RPC rejects zero.
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, "delta must be non-zero"),
    reason: z.enum(["receipt", "dispense", "return", "count", "adjustment"]),
    reference: z.string().trim().max(120).nullish(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

router.get(
  "/admin/catalog/products",
  adminReadRateLimiter,
  requirePermission("inventory.read"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(400).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      const { products, total } = await listProducts(orgId, {
        search: parsed.data.q ?? null,
        category: parsed.data.category ?? null,
        includeInactive: parsed.data.includeInactive,
        lowStockOnly: parsed.data.lowStockOnly,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
      });
      res.json({ products, total, categories: SUPPLY_CATEGORIES });
    } catch (err) {
      logger.error(
        { event: "catalog_list_failed", err: redactDbErr(err) },
        "admin/catalog: list failed",
      );
      res.status(500).json({ error: "catalog_unavailable" });
    }
  },
);

router.get(
  "/admin/catalog/low-stock",
  adminReadRateLimiter,
  requirePermission("inventory.read"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(400).json({ error: "tenant_context_missing" });
      return;
    }
    try {
      res.json({ products: await listLowStock(orgId) });
    } catch (err) {
      logger.error(
        { event: "catalog_low_stock_failed", err: redactDbErr(err) },
        "admin/catalog: low-stock query failed",
      );
      res.status(500).json({ error: "catalog_unavailable" });
    }
  },
);

router.get(
  "/admin/catalog/products/:sku",
  adminReadRateLimiter,
  requirePermission("inventory.read"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(400).json({ error: "tenant_context_missing" });
      return;
    }
    const params = skuParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_sku" });
      return;
    }
    try {
      const product = await getProduct(orgId, params.data.sku);
      if (!product) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      res.json({
        product,
        ledger: await listStockLedger(orgId, params.data.sku),
      });
    } catch (err) {
      logger.error(
        { event: "catalog_get_failed", err: redactDbErr(err) },
        "admin/catalog: detail failed",
      );
      res.status(500).json({ error: "catalog_unavailable" });
    }
  },
);

router.post(
  "/admin/catalog/products",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(400).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = upsertBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const body = parsed.data;
    if (body.category != null && !isSupplyCategory(body.category)) {
      res
        .status(400)
        .json({ error: "invalid_category", allowed: SUPPLY_CATEGORIES });
      return;
    }

    try {
      const existed = (await getProduct(orgId, body.sku)) !== null;
      const product = await upsertProduct(orgId, body, req.adminEmail ?? null);
      await logAudit({
        action: existed ? "catalog.product.updated" : "catalog.product.created",
        // SKU + category are warehouse identifiers, not PHI.
        metadata: { sku: product.sku, category: product.category },
      });
      res.status(existed ? 200 : 201).json({ product });
    } catch (err) {
      logger.error(
        { event: "catalog_upsert_failed", err: redactDbErr(err) },
        "admin/catalog: upsert failed",
      );
      res.status(500).json({ error: "catalog_unavailable" });
    }
  },
);

router.post(
  "/admin/catalog/products/:sku/stock",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(400).json({ error: "tenant_context_missing" });
      return;
    }
    const params = skuParam.safeParse(req.params);
    const parsed = stockBody.safeParse(req.body ?? {});
    if (!params.success || !parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    try {
      const balance = await adjustStock(
        orgId,
        { sku: params.data.sku, ...parsed.data },
        req.adminEmail ?? null,
      );
      await logAudit({
        action: "catalog.stock.adjusted",
        metadata: {
          sku: params.data.sku,
          delta: parsed.data.delta,
          reason: parsed.data.reason,
        },
      });
      res.json({ sku: params.data.sku, stockCount: balance });
    } catch (err) {
      if (err instanceof UnknownSkuError) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (err instanceof InsufficientStockError) {
        // 409, not 400: the request was well-formed, the shelf disagrees.
        res.status(409).json({ error: "insufficient_stock" });
        return;
      }
      logger.error(
        { event: "catalog_stock_adjust_failed", err: redactDbErr(err) },
        "admin/catalog: stock adjust failed",
      );
      res.status(500).json({ error: "catalog_unavailable" });
    }
  },
);

export default router;
