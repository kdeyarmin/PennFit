// /admin/shop/products/* — admin tools for the cash-pay catalog.
//
// This module owns the catalog mutations: PATCH the stock count /
// low-stock threshold / price on a Stripe Product, and POST a new SKU.
// The shop catalog reads inventory from `metadata.stock_count` (parsed
// by lib/stripe/products-meta.ts), so "set the stock count" is "write
// to Stripe metadata"; the storefront price is the product's
// `default_price`, so "edit the price" is "create a new Stripe Price
// and repoint default_price" (Stripe Prices are immutable). We
// deliberately don't introduce a separate inventory table; Stripe
// stays the single source of truth and an admin editing the value in
// the Stripe Dashboard directly produces the same on-storefront result
// as editing it from our admin console.
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

import express, { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Stripe from "stripe";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";
import {
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import {
  projectProduct,
  SHOP_CATEGORIES,
  type ShopProductView,
} from "../../lib/stripe/products-meta";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { dispatchBackInStockForProduct } from "../../lib/back-in-stock-record";
import { invalidateShopProductsCache } from "../shop/products";

const router: IRouter = Router();

// Per-admin rate limit on every catalog mutation (B-07). Each call
// hits Stripe (products.update / products.create / prices.create /
// prices.update) and can fan out a back-in-stock notification, so a compromised account
// looping on the endpoint can both burn Stripe quota and spam
// subscribers. 30/hour per-admin covers legitimate catalog work
// without bounding ops review or onboarding bursts. Keyed by
// adminUserId (populated by requireAdmin which runs first).
const adminProductMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: "admin_shop_product_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

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
    .describe(
      "Integer ≥0, or null to clear the threshold (storefront uses default of 5).",
    ),
});

// New storefront price in whole-dollar cents. Bounds mirror the
// create endpoint's unitAmountCents: Stripe's $0.50 minimum charge
// and a $100,000 sanity cap.
const patchPriceBodySchema = z.object({
  unitAmountCents: z
    .number()
    .int()
    .min(50, "Stripe minimum charge is $0.50")
    .max(10_000_000),
});

router.patch(
  "/admin/shop/products/:productId/stock",
  // Cash-pay catalog management. `admin.tools.manage` matches the
  // catalog's "supervisor-tier admin tooling" tier — admin /
  // supervisor / compliance_officer post-Phase-B collapse. CSRs +
  // fulfillment don't author stock-count overrides.
  requirePermission("admin.tools.manage"),
  adminProductMutationLimiter,
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
        { productId, ...stripeErrLogFields(err) },
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
        { productId, ...stripeErrLogFields(err) },
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

    // Back-in-stock fan-out: when stock transitions from 0 (or any
    // non-positive number) to a positive integer, fire the notify-me
    // queue. We deliberately ignore null->positive transitions
    // (admin first-tracking a previously-untracked SKU) to avoid
    // spamming a stale queue with no real "was out of stock"
    // semantics. Fire-and-forget so the admin save returns
    // immediately; the helper logs its own outcome.
    const wasOut =
      typeof existingProjected.stockCount === "number" &&
      existingProjected.stockCount <= 0;
    const nowIn =
      typeof projected.stockCount === "number" && projected.stockCount > 0;
    if (wasOut && nowIn) {
      const baseUrl =
        process.env.SHOP_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
        "https://pennpaps.com";
      const priceLabel =
        typeof projected.price?.unitAmount === "number"
          ? `$${(projected.price.unitAmount / 100).toFixed(2)}`
          : null;
      void dispatchBackInStockForProduct({
        productId,
        productName: projected.name,
        productImageUrl: projected.imageUrl ?? null,
        productUrl: `${baseUrl}/shop/p/${encodeURIComponent(productId)}`,
        priceLabel,
      }).catch((err) => {
        // Not a Stripe failure (the dispatch path is DB + email), so
        // the categorized Stripe fields don't apply — log the error
        // OBJECT: the logger's serializer keeps the error class while
        // its redaction blanks the free-text message/stack
        // (lib/logger.ts). The helper logs its own detailed outcome.
        req.log?.warn?.(
          { productId, err },
          "shop/admin/products: back-in-stock dispatch threw",
        );
      });
    }

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
  requirePermission("admin.tools.manage"),
  adminProductMutationLimiter,
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
        { productId, ...stripeErrLogFields(err) },
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
        { productId, ...stripeErrLogFields(err) },
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

// PATCH /admin/shop/products/:productId/price — change the storefront
// price of an existing SKU.
//
// Stripe Prices are immutable (unit_amount can never change on an
// existing Price object), so "edit the price" is a three-step write:
//   1. create a new one-time Price at the new amount (same currency)
//   2. repoint the product's `default_price` at it — this is the
//      moment the storefront (and checkout validation) switch over
//   3. archive the old default Price (hygiene; in-flight carts that
//      still hold the old price id are already rejected by
//      validate-cart's "must equal default_price" rule, archiving
//      just makes the rejection reason cleaner)
// The order matters: Stripe refuses to archive a Price that is still
// a product's default_price, so the repoint must land first.
//
// Subscribe & Save: v1 policy is "subscription price == one-time
// price" (no modeled discount — see products-meta.ts). When the SKU
// has active recurring Price(s), we mirror the storefront-selected
// one (cheapest active, id tie-break — same rule as validate-cart)
// onto a new recurring Price at the new amount and archive the old
// ones. Existing subscriptions are NOT touched: archiving a Price
// only prevents new use; Stripe keeps billing current subscribers on
// the price they signed up at.
//
// Failure posture mirrors the create endpoint: nothing before the
// default_price repoint has visible effect (a non-default price is
// not purchasable), and every step after it is best-effort hygiene —
// logged, never fatal — so a partial failure can't leave the SKU in
// a worse state than "old price object still active but unused".
router.patch(
  "/admin/shop/products/:productId/price",
  requirePermission("admin.tools.manage"),
  adminProductMutationLimiter,
  async (req, res) => {
    const productId = String(req.params.productId ?? "");
    if (!productId.startsWith("prod_")) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const parsed = patchPriceBodySchema.safeParse(req.body);
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
    const { unitAmountCents } = parsed.data;

    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json({ error: "stripe_not_configured" });
      return;
    }
    const stripe = getStripeClient(config);

    // Catalog-membership guard — same fence as the stock/threshold
    // handlers. Also gives us the current default price (id, amount,
    // currency) that steps 1–3 below need.
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
        { productId, ...stripeErrLogFields(err) },
        "shop/admin/products: stripe retrieve failed (price)",
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

    const previousPrice = existingProjected.price;
    if (previousPrice.unitAmount === unitAmountCents) {
      // Idempotent no-op: saving the already-current amount must not
      // churn out duplicate Price objects in Stripe.
      res.json({ product: existingProjected });
      return;
    }

    // Step 1 — new one-time price at the new amount. Currency follows
    // the existing default price so a non-USD catalog round-trips.
    let newPrice: { id: string };
    try {
      newPrice = await stripe.prices.create({
        product: productId,
        unit_amount: unitAmountCents,
        currency: previousPrice.currency,
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        { productId, ...stripeErrLogFields(err) },
        "shop/admin/products: stripe create price failed (price unchanged)",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_price_create_failed",
      });
      return;
    }

    // Step 2 — repoint default_price. This is the commit point: once
    // it lands, the storefront's next cache flush serves the new
    // price and checkout only accepts it.
    let updated;
    try {
      updated = await stripe.products.update(productId, {
        default_price: newPrice.id,
        expand: ["default_price"],
      });
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        { productId, newPriceId: newPrice.id, ...stripeErrLogFields(err) },
        "shop/admin/products: stripe set default_price failed (price edit; orphaned price)",
      );
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: "stripe_set_default_price_failed",
        productId,
      });
      return;
    }

    // The repoint is live in Stripe — drop the public catalog's
    // in-process cache so the storefront's next request serves the
    // new price immediately, instead of spending the rest of the 60s
    // TTL building carts against the replaced price id that checkout
    // validation is now rejecting.
    invalidateShopProductsCache();

    // Step 3 — archive the previous default price. Best-effort: a
    // failure leaves an unused-but-active price object behind, which
    // validate-cart already refuses to sell.
    try {
      await stripe.prices.update(previousPrice.id, { active: false });
    } catch (err) {
      req.log?.warn?.(
        { productId, priceId: previousPrice.id, ...stripeErrLogFields(err) },
        "shop/admin/products: archive of replaced default price failed",
      );
    }

    // Subscribe & Save rotation. Best-effort end to end: the one-time
    // price is already switched, so the worst outcome of a failure
    // here is a stale subscription price (logged loudly below) that
    // the operator can fix in the Stripe Dashboard.
    let recurringRotated = false;
    try {
      const recurringList = await stripe.prices.list({
        product: productId,
        active: true,
        type: "recurring",
        limit: 100,
      });
      const oldRecurring = recurringList.data;
      if (oldRecurring.length > 0) {
        // Mirror the cadence of the price the storefront actually
        // surfaces: cheapest active recurring, id tie-break — the
        // exact selection rule in validate-cart.ts / shop products.
        const mirrored = oldRecurring
          .filter((p) => p.unit_amount != null && p.recurring)
          .reduce<Stripe.Price | null>((best, p) => {
            if (!best) return p;
            const pa = p.unit_amount ?? Infinity;
            const ba = best.unit_amount ?? Infinity;
            if (pa !== ba) return pa < ba ? p : best;
            return p.id < best.id ? p : best;
          }, null);
        if (mirrored?.recurring) {
          const newRecurring = await stripe.prices.create({
            product: productId,
            unit_amount: unitAmountCents,
            currency: previousPrice.currency,
            recurring: {
              interval: mirrored.recurring.interval,
              interval_count: mirrored.recurring.interval_count ?? 1,
            },
          });
          // Only retire the old recurring prices once the replacement
          // exists — otherwise the SKU would lose its Subscribe toggle
          // entirely on a mid-flight failure.
          for (const old of oldRecurring) {
            if (old.id === newRecurring.id) continue;
            try {
              await stripe.prices.update(old.id, { active: false });
            } catch (err) {
              req.log?.warn?.(
                { productId, priceId: old.id, ...stripeErrLogFields(err) },
                "shop/admin/products: archive of replaced recurring price failed",
              );
            }
          }
          recurringRotated = true;
          // The catalog's recurringPrice projection changed as well —
          // a GET that landed between the repoint-invalidate above
          // and this rotation may have cached the old recurring
          // price, so drop the cache again.
          invalidateShopProductsCache();
        }
      }
    } catch (err) {
      req.log?.warn?.(
        { productId, ...stripeErrLogFields(err) },
        "shop/admin/products: recurring price rotation failed — subscription price is now stale vs one-time",
      );
    }

    const projected: ShopProductView | null = projectProduct(updated);
    if (!projected) {
      res.status(422).json({ error: "unprojectable_product" });
      return;
    }

    req.log?.info?.(
      {
        productId,
        previousUnitAmountCents: previousPrice.unitAmount,
        unitAmountCents,
        recurringRotated,
      },
      "shop/admin/products: price updated",
    );
    res.json({ product: projected });
  },
);

// POST /admin/shop/products/image-upload — upload a product photo and
// get back a public HTTPS URL ready to paste into the create form (or
// pass straight through as `imageUrl` on POST /admin/shop/products).
//
// Why this exists: the create endpoint accepts only an already-hosted
// HTTPS URL (Stripe fetches `images[]` server-side), which made "add a
// new item" a two-system chore — host the image somewhere public, then
// fill the form. This endpoint closes that gap by writing the bytes to
// the PUBLIC Supabase Storage bucket (`SUPABASE_STORAGE_BUCKET_PUBLIC`)
// and returning the bucket's public object URL, which Stripe can fetch.
//
// Deliberately NOT the private-bucket signed-PUT flow the POD /
// prescription uploads use: those are PHI and must stay private; a
// product photo is a public marketing asset, and Stripe needs to be
// able to GET it without a token. No ACL row is written — the public
// bucket is public by definition.
//
// Validation: content-type allowlist (png/jpeg/webp — the formats the
// storefront cards render), 5 MB cap, and a magic-byte sniff so a
// renamed non-image can't land in a public bucket under an image
// content type.
//
// Failure posture: fail-soft on config. When the public bucket env is
// unset the route 503s with `public_storage_not_configured`; the admin
// form keeps its paste-a-URL fallback, so nothing is lost in
// environments without the bucket.

const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const IMAGE_UPLOAD_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function sniffImageContentType(buf: Buffer): string | null {
  // Defensive re-guard: callers pass request-derived bytes, and the
  // length/index checks below must never run against an
  // attacker-shaped array or string (CodeQL js/type-confusion-
  // through-parameter-tampering).
  if (!Buffer.isBuffer(buf)) {
    return null;
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// Separate limiter from the catalog mutations: uploads don't touch
// Stripe, and a fumbled photo session (wrong crop, retry, retry)
// shouldn't eat the operator's 30/hour product-mutation budget.
const adminProductImageUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_shop_product_image_upload",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

router.post(
  "/admin/shop/products/image-upload",
  requirePermission("admin.tools.manage"),
  adminProductImageUploadLimiter,
  // Route-level raw parser: the global express.json() skips non-JSON
  // content types, so the image bytes arrive here untouched. Types
  // outside the allowlist are left unparsed and rejected below.
  express.raw({
    type: Object.keys(IMAGE_UPLOAD_EXTENSIONS),
    limit: IMAGE_UPLOAD_MAX_BYTES,
  }),
  async (req, res) => {
    const declaredType = (req.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const extension = IMAGE_UPLOAD_EXTENSIONS[declaredType];
    if (!extension) {
      res.status(415).json({
        error: "unsupported_image_type",
        supported: Object.keys(IMAGE_UPLOAD_EXTENSIONS),
      });
      return;
    }
    // Narrow the parsed body through an explicit Buffer guard ONCE
    // and use only the narrowed value below. express.raw leaves
    // req.body as `{}` for unmatched content types, and a tampered
    // request can present other shapes — never run length/index
    // checks against raw req.body.
    const rawBody: unknown = req.body;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    // Copy into a fresh Buffer rather than aliasing the request body.
    // Belt-and-braces detachment from the request object (and it makes
    // the value provably a Buffer to static analysis — CodeQL's
    // type-confusion query doesn't model Buffer.isBuffer as a type
    // guard, so length/index reads on the aliased body keep alerting).
    // At a 5 MB cap on an admin-only route the one-time copy is noise.
    const imageBytes: Buffer = Buffer.from(rawBody);
    const sniffed = sniffImageContentType(imageBytes);
    if (sniffed !== declaredType) {
      // The bytes don't match the declared format — refuse to plant
      // mystery content in a public bucket.
      res.status(400).json({ error: "image_bytes_mismatch" });
      return;
    }

    const bucket = (process.env.SUPABASE_STORAGE_BUCKET_PUBLIC ?? "").trim();
    if (!bucket) {
      res.status(503).json({ error: "public_storage_not_configured" });
      return;
    }

    const objectPath = `shop-products/${randomUUID()}.${extension}`;
    const supabase = getSupabaseServiceRoleClient();
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(objectPath, imageBytes, {
        contentType: declaredType,
        // Product images are content-addressed by UUID — a replaced
        // photo gets a fresh path, so long-lived caching is safe.
        cacheControl: "31536000",
        upsert: false,
      });
    if (uploadError) {
      req.log?.warn?.(
        { sizeBytes: imageBytes.length, contentType: declaredType },
        "shop/admin/products: image upload to public bucket failed",
      );
      res.status(502).json({ error: "image_upload_failed" });
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(objectPath);
    const imageUrl = publicUrlData?.publicUrl ?? null;
    if (!imageUrl) {
      res.status(502).json({ error: "image_upload_failed" });
      return;
    }

    req.log?.info?.(
      { sizeBytes: imageBytes.length, contentType: declaredType },
      "shop/admin/products: product image uploaded",
    );
    res.status(201).json({ imageUrl });
  },
);

// PATCH /admin/shop/products/:productId/details — edit the catalog
// copy of an existing SKU (name, description, tagline, replacement
// hint, manufacturer, model number, photo) without leaving the app.
// Until this endpoint, those fields were create-only and later edits
// required the Stripe Dashboard; stock/threshold/price already have
// their own dedicated PATCH endpoints above and stay untouched here.
//
// Field semantics:
//   - omitted        → unchanged
//   - null           → cleared (metadata key deleted via the ""
//                      sentinel; imageUrl null empties images[])
//   - name/description can be updated but not cleared — the catalog
//     projection requires both, so the schema doesn't accept null.
//
// Identity fields are deliberately NOT editable here: `shop_sku` is
// the stable identifier the seed script and collision guard key on,
// and `category`/`bundle_contents` change which storefront section
// (and card layout) the SKU renders in — both are "archive and
// re-create" operations per the create endpoint's docs.
//
// Same guard rails as the sibling PATCH handlers: prod_ prefix check,
// catalog-membership precheck via projectProduct, 503 in preview
// mode, per-admin mutation rate limit, cache invalidation on success.

const patchDetailsBodySchema = z
  .object({
    name: z.string().trim().min(2).max(250).optional(),
    description: z.string().trim().min(2).max(2000).optional(),
    tagline: z.string().trim().min(1).max(250).nullish(),
    replacementHint: z.string().trim().min(1).max(250).nullish(),
    manufacturer: z.string().trim().min(1).max(120).nullish(),
    modelNumber: z.string().trim().min(1).max(120).nullish(),
    imageUrl: z
      .string()
      .trim()
      .url()
      .startsWith("https://", "image URL must use https://")
      .max(500)
      .nullish(),
  })
  .strict();

router.patch(
  "/admin/shop/products/:productId/details",
  requirePermission("admin.tools.manage"),
  adminProductMutationLimiter,
  async (req, res) => {
    const productId = String(req.params.productId ?? "");
    if (!productId.startsWith("prod_")) {
      res.status(400).json({ error: "invalid_product_id" });
      return;
    }
    const parsed = patchDetailsBodySchema.safeParse(req.body);
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
    const changedFields = (
      Object.keys(input) as Array<keyof typeof input>
    ).filter((k) => input[k] !== undefined);
    if (changedFields.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        issues: [{ path: "", message: "provide at least one field to update" }],
      });
      return;
    }

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
        { productId, ...stripeErrLogFields(err) },
        "shop/admin/products: stripe retrieve failed (details)",
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

    // Stripe metadata semantics: "" deletes the key (the null →
    // cleared contract), a string records the new value, an absent
    // key in the patch object leaves the stored value untouched.
    const metadataPatch: Record<string, string> = {};
    const metadataKeyByField = {
      tagline: "tagline",
      replacementHint: "replacement_hint",
      manufacturer: "manufacturer",
      modelNumber: "model_number",
    } as const;
    for (const [field, metaKey] of Object.entries(metadataKeyByField) as Array<
      [keyof typeof metadataKeyByField, string]
    >) {
      const value = input[field];
      if (value === undefined) continue;
      metadataPatch[metaKey] = value === null ? "" : value;
    }

    const updatePayload: Stripe.ProductUpdateParams = {
      expand: ["default_price"],
    };
    if (input.name !== undefined) updatePayload.name = input.name;
    if (input.description !== undefined) {
      updatePayload.description = input.description;
    }
    if (Object.keys(metadataPatch).length > 0) {
      updatePayload.metadata = metadataPatch;
    }
    if (input.imageUrl !== undefined) {
      updatePayload.images = input.imageUrl === null ? [] : [input.imageUrl];
    }

    let updated;
    try {
      updated = await stripe.products.update(productId, updatePayload);
    } catch (err) {
      const status =
        typeof (err as { statusCode?: number })?.statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 502;
      req.log?.warn?.(
        { productId, ...stripeErrLogFields(err) },
        "shop/admin/products: stripe update failed (details)",
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

    // Catalog copy changed — flush the public 60s cache so the
    // storefront serves the edit immediately.
    invalidateShopProductsCache();

    req.log?.info?.(
      { productId, changedFields },
      "shop/admin/products: details updated",
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
//   Accepts a single optional HTTPS URL (passed through to Stripe
//   `images[]`). Operators can either paste a CDN URL (or a
//   https://app.pennpaps.com/products/<slug>.webp path that exists
//   in the cpap-fitter public dir), or upload a photo via
//   POST /admin/shop/products/image-upload above, which stores the
//   bytes in the public Supabase bucket and returns a URL ready to
//   use here.
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
  bundleContents: z.array(z.string().trim().min(1).max(250)).max(20).nullish(),
  // Recurring (subscription) price. Both fields must be present
  // together — see cross-field check below.
  recurringInterval: z.enum(["day", "week", "month", "year"]).nullish(),
  recurringIntervalCount: z.number().int().min(1).max(12).nullish(),
});

router.post(
  "/admin/shop/products",
  requirePermission("admin.tools.manage"),
  adminProductMutationLimiter,
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
            message: "bundleContents is only allowed when category is 'bundle'",
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
        { sku: input.sku, ...stripeErrLogFields(err) },
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
        { sku: input.sku, ...stripeErrLogFields(err) },
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
        { productId: product.id, sku: input.sku, ...stripeErrLogFields(err) },
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
          { productId: product.id, sku: input.sku, ...stripeErrLogFields(err) },
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
        { productId: product.id, sku: input.sku, ...stripeErrLogFields(err) },
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
