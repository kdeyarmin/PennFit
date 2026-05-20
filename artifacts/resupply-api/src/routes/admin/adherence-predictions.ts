// /admin/adherence-predictions — patient adherence score history.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { scoreAndPersistAdherence } from "../../lib/clinical/adherence-predictor";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/patients/:id/adherence/score",
  requireAdmin,
  adminRateLimit({ name: "adherence_predictions.score", preset: "mutation" }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const score = await scoreAndPersistAdherence(parsed.data.id);
    if (!score) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    await logAudit({
      action: "adherence.score",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "adherence_predictions",
      targetId: null,
      metadata: {
        patient_id: parsed.data.id,
        probability: score.probabilityCompliant,
        days_of_therapy: score.daysOfTherapy,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "adherence.score audit write failed");
    });
    res.json(score);
  },
);

router.get(
  "/admin/patients/:id/adherence/history",
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("adherence_predictions")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("scored_at", { ascending: false })
      .limit(50);
    res.json({ predictions: data ?? [] });
  },
);

router.get("/admin/adherence/at-risk", requireAdmin, async (_req, res) => {
  // Latest score per patient where probability < 0.5.
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("adherence_predictions")
    .select("patient_id, probability_compliant, days_of_therapy, scored_at")
    .lt("probability_compliant", 0.5)
    .order("scored_at", { ascending: false })
    .limit(100);
  res.json({ predictions: data ?? [] });
});

export default router;
