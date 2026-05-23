// /admin/referrals/scan-attribution — admin-trigger for the patient-
// referral conversion sweep. Idempotent; safe to fire on demand.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { attributePendingReferrals } from "../../lib/referrals/attribution";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    lookbackDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

router.post(
  "/admin/referrals/scan-attribution",
  // Manual sweep trigger — admin-tools tier (matches the rest of
  // the dispatcher manual triggers).
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "referrals.attribution_sweep", preset: "bulk" }),
  async (req, res) => {
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const result = await attributePendingReferrals(supabase, {
      lookbackDays: parsed.data.lookbackDays,
    });
    res.json(result);
  },
);

export default router;
