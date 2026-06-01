// /admin/billing/collections-forecast — AR collections projection
// (Owner #4, slice 1).
//
//   GET /admin/billing/collections-forecast
//       ?expectedDaysToPay=45&defaultAllowedRatio=0.5&collectionProbability=0.95
//
// Loads outstanding (submitted/accepted) claims and projects expected
// cash by horizon. The projection model + its assumptions live in
// lib/billing/collections-forecast.ts; assumptions are query-tunable and
// echoed back so the owner sees exactly what drove the number. Money +
// counts only — no PHI. reports.read.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  OUTSTANDING_AR_STATUSES,
  projectClaimCollections,
  type OutstandingClaim,
} from "../../lib/billing/collections-forecast";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const querySchema = z
  .object({
    expectedDaysToPay: z.coerce.number().int().min(1).max(365).optional(),
    defaultAllowedRatio: z.coerce.number().min(0).max(1).optional(),
    collectionProbability: z.coerce.number().min(0).max(1).optional(),
  })
  .strip();

router.get(
  "/admin/billing/collections-forecast",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("status, total_billed_cents, total_allowed_cents, submitted_at")
      .in("status", [...OUTSTANDING_AR_STATUSES])
      .limit(5000);
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const forecast = projectClaimCollections(
      (data ?? []) as unknown as OutstandingClaim[],
      {
        expectedDaysToPay: parsed.data.expectedDaysToPay,
        defaultAllowedRatio: parsed.data.defaultAllowedRatio,
        collectionProbability: parsed.data.collectionProbability,
      },
    );

    res.json(forecast);
  },
);

export default router;
