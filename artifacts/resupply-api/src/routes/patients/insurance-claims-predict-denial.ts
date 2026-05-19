// POST /admin/patients/:id/insurance-claims/:claimId/predict-denial
//
// Runs the heuristic denial scorer, persists onto insurance_claims,
// and returns the structured factor list. Triggered explicitly by
// the CSR — and (separately) by the AI scrub endpoint as a
// pre-filter so we only spend OpenAI tokens on claims worth the
// deep look.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";

import { scoreAndPersist } from "../../lib/billing/heuristic-denial-scorer";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

router.post(
  "/patients/:id/insurance-claims/:claimId/predict-denial",
  requireAdmin,
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const score = await scoreAndPersist(parsed.data.claimId);
    if (!score) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    await logAudit({
      action: "insurance_claim.predict_denial",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: parsed.data.claimId,
      metadata: {
        probability: score.probability,
        factor_count: score.factors.length,
        top_factor: score.factors[0]?.key ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.predict_denial audit write failed",
      );
    });
    res.json({
      probability: score.probability,
      factors: score.factors,
      scoredAt: score.scoredAt,
    });
  },
);

export default router;
