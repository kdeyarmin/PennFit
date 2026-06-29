// GET /shop/pickup-locations — public list of in-store pickup options.
//
// Returns the active business locations a customer can choose to collect
// an order from, plus an `enabled` flag the storefront uses to decide
// whether to show the "Pick up in store" choice at all.
//
// Gated by the `storefront.pickup` feature flag (seeded OFF). When the
// flag is off — or no active location exists — `enabled` is false and
// `locations` is empty, so the cart UI silently stays ship-only.
//
// Public + cacheable: location name/address/phone are business contact
// info, not PHI.

import { Router, type IRouter } from "express";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { listActivePickupLocations } from "../../lib/pickup/locations";
import { requestHost } from "../../lib/request-host";
import { resolveOrgIdByHost } from "../../lib/tenant-branding";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

const pickupLocationsLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  name: "shop_pickup_locations",
});

router.get(
  "/shop/pickup-locations",
  pickupLocationsLimiter,
  async (req, res) => {
    // Public route — no auth middleware populates req.orgId, so resolve
    // the tenant from the request host (verified custom domain → that
    // org; platform host / miss → seed org) before reading the flag, so
    // a tenant's storefront.pickup toggle gates THIS storefront.
    const orgId =
      req.orgId ?? (await resolveOrgIdByHost(requestHost(req))) ?? undefined;
    if (!(await isFeatureEnabled("storefront.pickup", orgId))) {
      res.json({ enabled: false, locations: [] });
      return;
    }
    const locations = await listActivePickupLocations(orgId ?? "");
    // Even with the flag on, pickup is only actually offerable when at
    // least one active location exists — report `enabled` accordingly so
    // the storefront doesn't render an empty picker.
    res.json({ enabled: locations.length > 0, locations });
  },
);

export default router;
