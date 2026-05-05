// Shop product compatibility endpoints (Phase B.3 / feature #11).
//
// Public read:
//   GET /shop/products/:productId/compatibility
//        — list machines this product is compatible with. Empty
//          array = universal. Drives the "Compatible with your
//          AirSense 11" badge on the product detail page.
//   GET /shop/products/compatibility?manufacturer=X&model=Y
//        — return compatibility data for the given machine for the
//          catalog page's "show only my-machine parts" filter.
//          The response separates explicitly compatible products
//          from constrained products; clients treat products not in
//          the constrained set as universal.
//
// Admin CRUD lives in /admin/shop/products/:productId/compatibility
// (separate file). Public reads here have no auth gate — catalog
// data is non-PHI and used by guest browsers.

import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { getDbPool, shopProductCompatibility } from "@workspace/resupply-db";

const router: IRouter = Router();

const productIdParam = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

const manufacturerParam = z.string().trim().min(1).max(120);
const modelParam = z.string().trim().min(1).max(200).optional();

router.get("/shop/products/:productId/compatibility", async (req, res) => {
  const parsed = productIdParam.safeParse(req.params.productId);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_product_id" });
    return;
  }
  const productId = parsed.data;

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopProductCompatibility.id,
      machineManufacturer: shopProductCompatibility.machineManufacturer,
      machineModel: shopProductCompatibility.machineModel,
      notes: shopProductCompatibility.notes,
    })
    .from(shopProductCompatibility)
    .where(eq(shopProductCompatibility.productId, productId))
    .limit(100);

  res.json({
    compatibility: rows.map((r) => ({
      id: r.id,
      machineManufacturer: r.machineManufacturer,
      machineModel: r.machineModel,
      notes: r.notes,
    })),
  });
});

router.get("/shop/products/compatibility", async (req, res) => {
  const mfrParsed = manufacturerParam.safeParse(req.query.manufacturer);
  if (!mfrParsed.success) {
    res.status(400).json({ error: "invalid_manufacturer" });
    return;
  }
  const manufacturer = mfrParsed.data;
  const modelParsed = modelParam.safeParse(req.query.model ?? undefined);
  if (!modelParsed.success) {
    res.status(400).json({ error: "invalid_model" });
    return;
  }
  const model = modelParsed.data ?? null;

  const db = drizzle(getDbPool());

  // Match the requested machine: rows where (manufacturer matches
  // case-insensitively) AND (model matches OR model is null — null
  // means "any model from this manufacturer"). When the caller
  // doesn't pass a model, we accept any row for the manufacturer.
  //
  // Returns the set of EXPLICITLY compatible product IDs. The SPA
  // unions this with "all products that have NO compatibility rows
  // at all" client-side to surface universal products too — that's
  // simpler than a NOT EXISTS subquery and fits how the catalog
  // is hydrated (one product list + this filter overlay).
  const rows = await db
    .selectDistinct({
      productId: shopProductCompatibility.productId,
    })
    .from(shopProductCompatibility)
    .where(
      and(
        sql`lower(${shopProductCompatibility.machineManufacturer}) = lower(${manufacturer})`,
        model
          ? sql`(${shopProductCompatibility.machineModel} IS NULL OR lower(${shopProductCompatibility.machineModel}) = lower(${model}))`
          : sql`true`,
      ),
    );

  // Also surface the set of products that are constrained AT ALL
  // (i.e. have any compatibility row). The SPA uses this to know
  // "anything NOT in this list is universal" — without it, a guest
  // browsing a product without compat rows would have to do a
  // per-product round-trip to know whether to show it. Client filter:
  //
  //   keepProduct(p) =
  //     explicitCompatibleProductIds.includes(p.id) ||
  //     !constrainedProductIds.includes(p.id)
  const allConstrainedRows = await db
    .selectDistinct({ productId: shopProductCompatibility.productId })
    .from(shopProductCompatibility);

  res.json({
    explicitCompatibleProductIds: rows.map((r) => r.productId),
    constrainedProductIds: allConstrainedRows.map((r) => r.productId),
  });
});

export default router;
