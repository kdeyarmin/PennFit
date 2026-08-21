// /admin/integrations/nightly-sync — admin manual trigger for the
// nightly-sync sweep for THIS tenant. Runs synchronously and returns
// the aggregate counters. Useful for "I just plugged in a new partner;
// refresh every linked patient right now" workflows.
//
// Must NOT fan out across every org: this route is gated by
// requireAdminOnly for the caller's tenant. The platform-wide sweep
// stays on the pg-boss cron (`runTherapyNightlySync`).

import { Router, type IRouter } from "express";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdminOnly } from "../../middlewares/requireAdmin";
import { runTherapyNightlySyncForOrg } from "../../worker/jobs/therapy-integrations-nightly-sync";

const router: IRouter = Router();

router.post(
  "/admin/integrations/nightly-sync",
  requireAdminOnly,
  adminRateLimit({ name: "integrations.nightly_sync_trigger", preset: "bulk" }),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const result = await runTherapyNightlySyncForOrg(orgId);
    res.json(result);
  },
);

export default router;
