// GET /api/storefront-branding — public, host-resolved storefront identity.
//
// The SPA fetches this once on first paint and renders the resolving
// tenant's storefront name, tagline, and logo instead of the bundled
// PennPaps defaults. Strictly public brand identity — never anything
// tenant-private. Resolved by the request Host: a verified custom domain
// gets that tenant's brand; every other host gets the seed/default brand,
// so the canonical site is unchanged.
//
// Cached per host in-process (resolveBrandingByHost) plus a short
// edge/browser Cache-Control, so it adds no per-page DB load.

import { Router, type IRouter } from "express";

import { requestHost } from "../../lib/request-host";
import { resolveBrandingByHost } from "../../lib/tenant-branding";

const router: IRouter = Router();

router.get("/storefront-branding", async (req, res) => {
  const branding = await resolveBrandingByHost(requestHost(req));
  // Vary on the forwarded host so a shared edge cache can't serve one
  // tenant's brand to another.
  res.set("Vary", "X-Forwarded-Host");
  res.set("Cache-Control", "public, max-age=300");
  res.json(branding);
});

export default router;
