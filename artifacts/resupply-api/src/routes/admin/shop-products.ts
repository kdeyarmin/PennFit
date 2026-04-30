// /admin/shop/products/* — admin tools for the cash-pay catalog.
//
// Today this module owns exactly one endpoint: PATCH the stock count
// on a Stripe Product. The shop catalog reads inventory from
// `metadata.stock_count` (parsed by lib/stripe/products-meta.ts), so
// "set the stock count" is "write to Stripe metadata". We deliberately
// don't introduce a separate inventory table; Stripe stays the single
// source of truth and an admin editing the value in the Stripe
// Dashboard directly produces the same on-storefront result as
// editing it from our admin console.
//
// Why metadata (not Stripe's catalog inventory feature):
//   Stripe's hosted "inventory" is part of Stripe Tax / Stripe Terminal
//   and not exposed to the Checkout-only flow we run. Metadata is the
//   documented, supported way to attach free-form structured data to
//   a Product, the value comes back on every `products.list`/retrieve
//   call (no extra round-trip), and an outage of any future inventory
//   feature can never silently take the storefront offline.
//
// Authorization:
//   requireAdmin (RESUPPLY_ADMIN_EMAILS allowlist). The handler also
//   re-projects the updated product through the same code path the
//   public catalog uses, so the response payload is byte-identical
//   to what /shop/products will return on its next cache flush.

import { Router, type IRouter } from "express";
import { z } from "zod";
import type Stripe from "stripe";

import { requireAdmin } from "../../middlewares/requireAdmin";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
  SHOP_CATEGORIES,
  type ShopProductView,
} from "../../lib/stripe/products-meta";

const router: IRouter = Router();

// Input shape: integer stock count, OR null to UNTRACK the SKU.
// Negative values are explicitly rejected — the parsing path in
// products-meta also normalises negatives to "untracked", but doing
// the validation here lets the admin UI render a clean error rather
// than silently flipping the SKU into the untracked state.
const patchBodySchema = z.object({
  stockCount: z
    .union([z.number().int().min(0).max(1_000_000), z.null()])
    .describe("Integer ≥0, or null to clear the metadata key."),
});

// Per-SKU "Only N left" threshold. Same null-as-untrack semantics
// as the stock count, capped at 1000 to match the projection layer's
// cap (anything above is operationally meaningless and would let a
// typo blow up the admin UI display).
const patchThresholdBodySchema = z.object({
  lowStockThreshold: z
    .union([z.number().int().min(0).max(1000), z.null()])
    .describe("Integer ≥0, or null to clear the threshold (storefront uses default of 5)."),
});

router.patch(
  "/admin/shop/products/:productId/stock",
  requireAdmin,
  async (req, res) => {
    const productId = String(req.params.productId ?? "");
    if (!productId.startsWith("prod_")) {
      // Defense in depth: the route param is user-controlled and
      // anything we send to Stripe lands in their audit log. Reject
      // before round-tripping garbage to a 3rd party.
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { stockCount } = parsed.data;

    const config = readStripeConfigOrNull();
    if (!config) {
      // Preview mode — the shop catalog is a synthesized fixture and
      // there is no Stripe to write to. Surface a clean 503 so the
      // admin UI can render an explainer ("set STRIPE_SECRET_KEY to
      // edit inventory") instead of the generic error toast.
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }

    const stripe = getStripeClient(config);

    // Catalog-membership guard: retrieve + project the product BEFORE
    // mutating it. Without this guard the route would happily write
    // `stock_count` metadata to ANY Stripe product the prefix-check
    // accepts — including line items from other Stripe Products an
    // operator never intended to expose to the shop. Catalog
    // membership is defined by `projectProduct(...)` returning a
    // ShopProductView (right metadata.shop_category, default_price,
    // etc). The pre-check costs one extra Stripe round-trip per
    // admin save; that's fine for an admin-only, low-frequency
    // editor and worth it for the safety property.
    let existing;
    try {
      existing = await stripe.products.retrieve(productId, {
        expand: ["default_price"],
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      // Stripe surfaces "no such product" as 404; pass it through so
      // the admin UI can render a clean "product not found" instead
      // of the generic error toast.
      if (status === 404) {
        res.status(404).json({ error: "product_not_found" });
        return;
      }
      req.log?.warn?.(
        {
          productId,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe retrieve failed",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_retrieve_failed",
      });
      return;
    }
    const existingProjected: ShopProductView | null = projectProduct(existing);
    if (!existingProjected) {
      // The product exists in Stripe but isn't in the shop catalog
      // (missing shop_category metadata, no default_price, etc).
      // Refusing to write keeps the admin endpoint from being a
      // generic Stripe metadata setter.
      res.status(404).json({ error: "product_not_in_catalog" });
      return;
    }

    // Stripe metadata semantics: setting a key to "" deletes it, which
    // is exactly the contract we want for `stockCount === null`.
    // Setting to a string number records the new tracked value.
    const metadataPatch: Record<string, string> =
      stockCount === null
        ? { stock_count: "" }
        : { stock_count: String(stockCount) };

    let updated;
    try {
      updated = await stripe.products.update(productId, {
        metadata: metadataPatch,
        // Re-expand default_price so projectProduct can reuse the same
        // projection used by the public catalog endpoint without a
        // second round trip.
        expand: ["default_price"],
      });
    } catch (err) {
      // Stripe SDK throws StripeError subclasses for 4xx/5xx; we
      // forward the status when known so the UI can disambiguate
      // "no such product" from "Stripe is down".
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          productId,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe update failed",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_update_failed",
      });
      return;
    }

    const projected: ShopProductView | null = projectProduct(updated);
    if (!projected) {
      // The product still exists in Stripe but failed our shape
      // checks (no default_price, missing category metadata, etc).
      // Returning a clean 422 lets the admin UI surface "this product
      // is missing required catalog fields" rather than a 500.
      res.status(422).json({ error: "unprojectable_product" });
      return;
    }

    req.log?.info?.(
      { productId, stockCount },
      "shop/admin/products: stock count updated",
    );
    res.json({ product: projected });
  },
);

// PATCH /admin/shop/products/:productId/threshold — sets the
// per-SKU low-stock threshold via Stripe metadata
// (`low_stock_threshold`). Storefront badge logic: when stockCount
// is between 1 and threshold (inclusive), render "Only N left".
// `null` clears the metadata key, falling back to the default of 5.
//
// Same shape as the stock-count handler: catalog-membership guard,
// metadata patch, re-projection. We deliberately keep this as a
// SEPARATE endpoint (not a combined PATCH on the product) so:
//   - the audit log makes it obvious which field changed
//   - a stock-count save can't accidentally clobber the threshold
//   - the existing /stock endpoint contract + tests stay untouched.
router.patch(
  "/admin/shop/products/:productId/threshold",
  requireAdmin,
  async (req, res) => {
    const productId = String(req.params.productId ?? "");
    if (!productId.startsWith("prod_")) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const parsed = patchThresholdBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { lowStockThreshold } = parsed.data;

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);

    let existing;
    try {
      existing = await stripe.products.retrieve(productId, {
        expand: ["default_price"],
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      if (status === 404) {
        res.status(404).json({ error: "product_not_found" });
        return;
      }
      req.log?.warn?.(
        {
          productId,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe retrieve failed (threshold)",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_retrieve_failed",
      });
      return;
    }
    const existingProjected: ShopProductView | null = projectProduct(existing);
    if (!existingProjected) {
      res.status(404).json({ error: "product_not_in_catalog" });
      return;
    }

    const metadataPatch: Record<string, string> =
      lowStockThreshold === null
        ? { low_stock_threshold: "" }
        : { low_stock_threshold: String(lowStockThreshold) };

    let updated;
    try {
      updated = await stripe.products.update(productId, {
        metadata: metadataPatch,
        expand: ["default_price"],
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          productId,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe update failed (threshold)",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_update_failed",
      });
      return;
    }

    const projected: ShopProductView | null = projectProduct(updated);
    if (!projected) {
      res.status(422).json({ error: "unprojectable_product" });
      return;
    }

    req.log?.info?.(
      { productId, lowStockThreshold },
      "shop/admin/products: low-stock threshold updated",
    );
    res.json({ product: projected });
  },
);

// POST /admin/shop/products — create a new SKU in the Stripe catalog.
//
// What this writes (idempotent against `metadata.shop_sku`):
//   - Stripe Product (name, description, metadata, optional images)
//   - Stripe Price (one-time, USD, in whole-dollar cents)
//   - default_price set on the product so /shop/products picks it up
//   - OPTIONAL second Price (recurring) for cadence subscriptions —
//     not set as default; the storefront reads it via the
//     `recurringPrice` projection field.
//
// SKU collision guard:
//   We require operators to use `metadata.shop_sku` as the stable
//   identifier (matches seed-stripe-products.ts). Before creating
//   we search Stripe for an active product carrying the same sku;
//   if found we 409 with the existing product id so the admin UI
//   can offer "edit existing" instead. The SKU regex below
//   restricts inputs to [a-z0-9-]+ which sidesteps Stripe search
//   query quoting issues entirely.
//
// Image handling:
//   The MVP accepts a single optional HTTPS URL (passed through to
//   Stripe `images[]`). We deliberately do NOT operate an image
//   upload service in this slice — ADR 008/010 explicitly chose
//   "no S3, no cache" for this product. Operators paste a CDN URL
//   (or a https://app.pennpaps.com/products/<slug>.webp path that
//   exists in the cpap-fitter public dir). Object storage is on
//   the W4 backlog if/when that constraint changes.
//
// Authorization:
//   requireAdmin — agents can add products. Adding a SKU is not a
//   destructive operation (the worst case is "unused product in
//   the catalog" which an operator can archive in the Stripe
//   Dashboard). The DELETE counterpart, if/when added, must use
//   requireAdminOnly.
//
// Failure mode: orphaned product
//   If the price-create step fails after the product-create succeeds,
//   the product exists in Stripe with no `default_price` and will
//   not project into the shop catalog (projectProduct returns null
//   without a default_price). We surface a 502 with the
//   `productId` so the operator can finish the price in Stripe
//   directly or re-run with the same SKU (the collision guard
//   will then 409 the second attempt — by design).

const createBodySchema = z.object({
  sku: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, and hyphens only"),
  name: z.string().trim().min(2).max(250),
  description: z.string().trim().min(2).max(2000),
  category: z.enum(SHOP_CATEGORIES),
  unitAmountCents: z
    .number()
    .int()
    .min(50, "Stripe minimum charge is $0.50")
    .max(10_000_000),
  tagline: z.string().trim().max(250).nullish(),
  replacementHint: z.string().trim().max(250).nullish(),
  manufacturer: z.string().trim().max(120).nullish(),
  modelNumber: z.string().trim().max(120).nullish(),
  // Optional HTTPS image URL passed through to Stripe images[].
  // Stripe also requires the URL to be publicly fetchable — we
  // don't probe for that here (Stripe will reject at create time
  // if it can't fetch). Length cap mirrors Stripe's hard limit.
  imageUrl: z
    .string()
    .trim()
    .url()
    .startsWith("https://", "image URL must use https://")
    .max(500)
    .nullish(),
  stockCount: z.number().int().min(0).max(1_000_000).nullish(),
  lowStockThreshold: z.number().int().min(0).max(1000).nullish(),
  bundleContents: z
    .array(z.string().trim().min(1).max(250))
    .max(20)
    .nullish(),
  // Recurring (subscription) price. Both fields must be present
  // together — see cross-field check below.
  recurringInterval: z.enum(["day", "week", "month", "year"]).nullish(),
  recurringIntervalCount: z.number().int().min(1).max(12).nullish(),
});

router.post(
  "/admin/shop/products",
  requireAdmin,
  async (req, res) => {
    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const input = parsed.data;

    // Cross-field: bundleContents only valid when category=bundle.
    // The storefront's bundle-card layout reads metadata.bundle_contents
    // directly; setting it on a non-bundle SKU would render the
    // bullet list under a non-bundle product card.
    if (
      input.bundleContents &&
      input.bundleContents.length > 0 &&
      input.category !== "bundle"
    ) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "bundleContents",
            message:
              "bundleContents is only allowed when category is 'bundle'",
          },
        ],
      });
      return;
    }

    // Cross-field: recurring price needs both interval + intervalCount.
    // Either both present or both absent.
    const wantsRecurring = !!(
      input.recurringInterval || input.recurringIntervalCount
    );
    if (
      wantsRecurring &&
      !(input.recurringInterval && input.recurringIntervalCount)
    ) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "recurringInterval",
            message:
              "recurringInterval and recurringIntervalCount must both be provided",
          },
        ],
      });
      return;
    }

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);

    // SKU collision guard. Search Stripe for an active product
    // already carrying this `metadata.shop_sku`. The SKU regex
    // restricts inputs to [a-z0-9-]+, so safe to interpolate
    // into the Stripe search query string.
    let existingBySku;
    try {
      existingBySku = await stripe.products.search({
        query: `metadata['shop_sku']:'${input.sku}' AND active:'true'`,
        limit: 1,
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          sku: input.sku,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe search failed",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_search_failed",
      });
      return;
    }
    if (existingBySku.data[0]) {
      res.status(409).json({
        error: "sku_already_exists",
        productId: existingBySku.data[0].id,
      });
      return;
    }

    // Build metadata. Mirrors seed-stripe-products.ts so a product
    // created here is byte-equivalent to one seeded from the script.
    const metadata: Record<string, string> = {
      shop_sku: input.sku,
      category: input.category,
    };
    if (input.tagline) metadata.tagline = input.tagline;
    if (input.replacementHint)
      metadata.replacement_hint = input.replacementHint;
    if (input.manufacturer) metadata.manufacturer = input.manufacturer;
    if (input.modelNumber) metadata.model_number = input.modelNumber;
    if (input.stockCount != null)
      metadata.stock_count = String(input.stockCount);
    if (input.lowStockThreshold != null)
      metadata.low_stock_threshold = String(input.lowStockThreshold);
    if (input.bundleContents && input.bundleContents.length > 0) {
      metadata.bundle = "true";
      // JSON-encode for robust round-tripping (Stripe metadata cap
      // is 500 chars per value; bundle contents are short bullets).
      metadata.bundle_contents = JSON.stringify(input.bundleContents);
    }

    const createPayload: Stripe.ProductCreateParams = {
      name: input.name,
      description: input.description,
      metadata,
    };
    if (input.imageUrl) {
      createPayload.images = [input.imageUrl];
    }

    let product: { id: string };
    try {
      product = await stripe.products.create(createPayload);
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          sku: input.sku,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe create product failed",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_create_failed",
      });
      return;
    }

    // Create one-time price.
    let price: { id: string };
    try {
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: input.unitAmountCents,
        currency: "usd",
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          productId: product.id,
          sku: input.sku,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe create price failed (product orphaned)",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_price_create_failed",
        productId: product.id,
      });
      return;
    }

    // Optional recurring (subscription) price. The storefront reads
    // it via projectProduct's `recurringPrice` field. We do NOT set
    // it as default_price — default stays the one-time price so a
    // plain "Buy now" still works. Failure here is non-fatal: the
    // operator can add the recurring price via the Stripe Dashboard.
    let recurringPriceId: string | null = null;
    if (input.recurringInterval && input.recurringIntervalCount) {
      try {
        const recurring = await stripe.prices.create({
          product: product.id,
          unit_amount: input.unitAmountCents,
          currency: "usd",
          recurring: {
            interval: input.recurringInterval,
            interval_count: input.recurringIntervalCount,
          },
        });
        recurringPriceId = recurring.id;
      } catch (err) {
        req.log?.warn?.(
          {
            productId: product.id,
            sku: input.sku,
            err: err instanceof Error ? err.message : String(err),
          },
          "shop/admin/products: recurring price create failed (one-time price still set)",
        );
        // Continue — the product is usable as a one-time SKU.
      }
    }

    // Set default_price + re-retrieve with expand so the projection
    // pipeline below has the same shape /shop/products consumes.
    let updated;
    try {
      updated = await stripe.products.update(product.id, {
        default_price: price.id,
        expand: ["default_price"],
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        {
          productId: product.id,
          sku: input.sku,
          err: err instanceof Error ? err.message : String(err),
        },
        "shop/admin/products: stripe set default_price failed",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_set_default_price_failed",
        productId: product.id,
      });
      return;
    }

    const projected: ShopProductView | null = projectProduct(updated);
    if (!projected) {
      // Product + price exist in Stripe but our projection gate
      // rejects (most likely missing/invalid metadata.category).
      // Returning 422 with the productId lets the admin UI offer a
      // "fix in Stripe Dashboard" link rather than a generic 500.
      res.status(422).json({
        error: "unprojectable_product",
        productId: product.id,
      });
      return;
    }

    req.log?.info?.(
      {
        productId: product.id,
        sku: input.sku,
        unitAmountCents: input.unitAmountCents,
        hasRecurring: !!recurringPriceId,
      },
      "shop/admin/products: product created",
    );
    res.status(201).json({ product: projected });
  },
);

export default router;
