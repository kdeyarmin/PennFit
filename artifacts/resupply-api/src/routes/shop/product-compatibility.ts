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
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

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

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_product_compatibility")
    .select("id, machine_manufacturer, machine_model, notes")
    .eq("product_id", productId)
    .limit(100);
  if (error) throw error;

  res.json({
    compatibility: (data ?? []).map((r) => ({
      id: r.id,
      machineManufacturer: r.machine_manufacturer,
      machineModel: r.machine_model,
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

  const supabase = getSupabaseServiceRoleClient();

  // Match the requested machine: rows where the manufacturer matches
  // case-insensitively AND (model matches OR model is null — null
  // means "any model from this manufacturer"). When the caller
  // doesn't pass a model, we accept any row for the manufacturer.
  // PostgREST's `.ilike(col, value)` with no wildcards is exact
  // case-insensitive equality. Two ilikes are AND'd; the model
  // disjunction goes through `.or(...)`.
  let matchQuery = supabase
    .schema("resupply")
    .from("shop_product_compatibility")
    .select("product_id")
    .ilike("machine_manufacturer", manufacturer);
  if (model) {
    // ilike pattern is value-controlled here; both the column name and
    // the operator are literal. PostgREST escapes `,` inside `.or()`
    // values via `*` so we restrict the param value to the validated
    // shape (model went through Zod above).
    matchQuery = matchQuery.or(
      `machine_model.is.null,machine_model.ilike.${model}`,
    );
  }
  const { data: matched, error: matchedErr } = await matchQuery;
  if (matchedErr) throw matchedErr;

  // Also surface the set of products that are constrained AT ALL
  // (i.e. have any compatibility row). The SPA uses this to know
  // "anything NOT in this list is universal" — without it, a guest
  // browsing a product without compat rows would have to do a
  // per-product round-trip to know whether to show it.
  const { data: allConstrained, error: allErr } = await supabase
    .schema("resupply")
    .from("shop_product_compatibility")
    .select("product_id");
  if (allErr) throw allErr;

  // PostgREST has no SELECT DISTINCT; dedupe in JS. The compatibility
  // table is small (one row per product × machine combo, ≪ 1000 rows
  // even for a full catalog), so the dedup cost is trivial.
  const explicitCompatibleProductIds = Array.from(
    new Set((matched ?? []).map((r) => r.product_id)),
  );
  const constrainedProductIds = Array.from(
    new Set((allConstrained ?? []).map((r) => r.product_id)),
  );

  res.json({
    explicitCompatibleProductIds,
    constrainedProductIds,
  });
});

export default router;
