// GET /admin/webhook-event-catalog
//
// Read-only static catalog. The admin UI uses this to populate
// the "events you can subscribe to" picker; the docs page renders
// it as a reference table.

import { Router, type IRouter } from "express";

import { WEBHOOK_EVENT_CATALOG } from "../../lib/webhooks/event-catalog";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/webhook-event-catalog",
  adminReadRateLimiter,
  requireAdmin,
  (_req, res) => {
    res.json({ events: WEBHOOK_EVENT_CATALOG });
  },
);

export default router;
