// POST /admin/shop/catalog/seed — one-click "load starter catalog".
//
// Provisions the tenant-neutral starter catalog (lib/stripe/starter-catalog)
// into the tenant's OWN Stripe account so a brand-new storefront isn't
// empty. Idempotent: re-running only updates existing SKUs (matched by
// metadata.shop_sku) and never duplicates. The tenant then edits
// names/prices from /admin/shop/inventory.
//
// Account targeting (Connect direct charges): products are written to the
// account the storefront READS from and checkout routes to — the connected
// account once the tenant has completed Stripe Connect (charges enabled),
// otherwise the platform account. To stop a non-seed tenant from polluting
// the SHARED platform account, a platform-account seed is allowed ONLY for
// the seed tenant; every other tenant must connect Stripe first
// (409 connect_stripe_first).
//
// Gate: `admin.tools.manage` — the same owner-tier permission the catalog
// mutations in shop-products.ts use.

import { Router, type IRouter } from "express";

import { logAudit } from "@workspace/resupply-audit";
import { resolveSeedOrgId } from "@workspace/resupply-db";

import { redactDbErr } from "../../lib/redact-db-err";
import { logger } from "../../lib/logger";
import {
  getStripeClient,
  readStripeConfigOrNull,
  SHOP_UNAVAILABLE_BODY,
} from "../../lib/stripe/config";
import { stripeAccountRequestOptions } from "../../lib/stripe/connect";
import { seedStarterCatalog } from "../../lib/stripe/starter-catalog";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";
import { rateLimit } from "../../middlewares/rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requirePermission } from "../../middlewares/requireAdmin";
import { invalidateShopProductsCache } from "../shop/products";

const router: IRouter = Router();

// Bulk operation: ~28 products × up to 3 Stripe writes each. Strict
// per-admin limit — a tenant only needs to seed once (it's idempotent), so
// 5/hour leaves room for a couple of retries without enabling abuse. Keyed
// by adminUserId (populated by requireAdmin, which requirePermission runs).
const catalogSeedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: "admin_shop_catalog_seed",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

router.post(
  "/admin/shop/catalog/seed",
  // requirePermission (→ requireAdmin) first so the limiter keys on the real
  // adminUserId and withIdempotency sees an authenticated admin.
  requirePermission("admin.tools.manage"),
  catalogSeedLimiter,
  // Replay-safe: a client that sends an Idempotency-Key gets the first
  // response replayed on a retry/double-submit instead of re-seeding.
  withIdempotency("POST /admin/shop/catalog/seed"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const config = readStripeConfigOrNull();
    if (!config) {
      res.status(503).json(SHOP_UNAVAILABLE_BODY);
      return;
    }

    // Target the account the storefront reads from. A connected account is
    // returned only once Connect onboarding has enabled charges; otherwise
    // this resolves to the platform account.
    const accountOptions = await stripeAccountRequestOptions(orgId);
    if (!accountOptions.stripeAccount) {
      // Would write to the SHARED platform account. Only the seed tenant
      // (which legitimately runs on the platform account) may do that; every
      // other tenant must connect Stripe first so their starter products
      // land in their OWN books, not mixed into the platform account.
      const seedOrgId = await resolveSeedOrgId();
      if (orgId !== seedOrgId) {
        res.status(409).json({
          error: "connect_stripe_first",
          message:
            "Connect your Stripe account and finish onboarding before loading a starter catalog, so products are created in your own account.",
        });
        return;
      }
    }

    const stripe = getStripeClient(config);
    try {
      const result = await seedStarterCatalog(stripe, {
        requestOptions: accountOptions,
      });
      // New products won't appear on the storefront until the per-tenant
      // catalog cache expires; drop it now so the change is visible at once.
      invalidateShopProductsCache();

      await logAudit({
        action: "shop.catalog.seeded",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "organizations",
        targetId: orgId,
        metadata: {
          created: result.created,
          updated: result.updated,
          pricesCreated: result.pricesCreated,
          total: result.total,
          connectedAccount: Boolean(accountOptions.stripeAccount),
        },
        ip: req.ip ?? null,
        userAgent: null,
      }).catch((err) => {
        logger.warn({ err: redactDbErr(err) }, "catalog-seed: audit failed");
      });

      res.json(result);
    } catch (err) {
      logger.warn(
        { ...stripeErrLogFields(err) },
        "catalog-seed: starter catalog seed failed",
      );
      res.status(502).json({ error: "catalog_seed_failed" });
    }
  },
);

export default router;
