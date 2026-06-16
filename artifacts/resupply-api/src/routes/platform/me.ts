// /resupply-api/platform/me — platform super-admin identity probe (G4).
//
// The platform console's equivalent of /resupply-api/me: a single cheap
// call the SPA makes after sign-in to ask "am I a platform super-admin on
// THIS server?". It drives whether to render the platform console (200),
// the "not a platform admin" screen (403), or the sign-in redirect (401).
//
// Gated by `requirePlatformAdmin`, so by the time the handler runs the
// caller is proven to be a member of `resupply.platform_admins`; it
// attached `platformAdminUserId` + `platformAdminEmail`. We echo only
// those two identifiers — never the session token or the admins list.

import { Router, type IRouter } from "express";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

router.get(
  "/platform/me",
  adminReadRateLimiter,
  requirePlatformAdmin,
  (req, res) => {
    res.json({
      userId: req.platformAdminUserId ?? "",
      email: req.platformAdminEmail ?? null,
    });
  },
);

export default router;
