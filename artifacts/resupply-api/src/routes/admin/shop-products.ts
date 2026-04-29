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

import { requireAdmin } from "../../middlewares/requireAdmin";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
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

export default router;
