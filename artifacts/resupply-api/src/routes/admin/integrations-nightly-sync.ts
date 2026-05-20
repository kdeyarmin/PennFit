// /admin/integrations/nightly-sync — admin manual trigger for the
// nightly-sync sweep. Runs synchronously and returns the aggregate
// counters. Useful for "I just plugged in a new partner; refresh
// every linked patient right now" workflows.

import { Router, type IRouter } from "express";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";
import { runTherapyNightlySync } from "../../worker/jobs/therapy-integrations-nightly-sync";

const router: IRouter = Router();

router.post(
  "/admin/integrations/nightly-sync",
  requireAdminOnly,
  adminRateLimit({ name: "integrations.nightly_sync_trigger", preset: "bulk" }),
  async (_req, res) => {
    const result = await runTherapyNightlySync();
    res.json(result);
  },
);

export default router;
