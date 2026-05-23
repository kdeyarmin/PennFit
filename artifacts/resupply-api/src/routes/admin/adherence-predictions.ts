// /admin/adherence-predictions — patient adherence score history.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { scoreAndPersistAdherence } from "../../lib/clinical/adherence-predictor";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/patients/:id/adherence/score",
  requirePermission("patients.read"),
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
  requirePermission("patients.read"),
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

router.get(
  "/admin/adherence/at-risk",
  requirePermission("patients.read"),
  async (_req, res) => {
  // Latest score per patient where probability < 0.5.
  //
  // The naive approach (filter rows by probability_compliant < 0.5
  // on the append-only history) returned EVERY historical at-risk
  // score, including patients who have since recovered to >0.5 —
  // so a recovered patient still appeared and the same at-risk
  // patient appeared once per scoring event. CSRs worked phantom
  // risk and the same patient repeatedly.
  //
  // The right query is "for each patient, take the LATEST scored_at
  // row and surface it only if that latest row is < 0.5". PostgREST
  // doesn't expose DISTINCT ON, so we pull a wider window ordered
  // by scored_at desc and de-dupe by patient_id JS-side.
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("adherence_predictions")
    .select("patient_id, probability_compliant, days_of_therapy, scored_at")
    .order("scored_at", { ascending: false })
    .limit(2000);
  const latestByPatient = new Map<
    string,
    {
      patient_id: string;
      probability_compliant: number;
      days_of_therapy: number;
      scored_at: string;
    }
  >();
  for (const row of (data ?? []) as Array<{
    patient_id: string;
    probability_compliant: number;
    days_of_therapy: number;
    scored_at: string;
  }>) {
    if (!latestByPatient.has(row.patient_id)) {
      latestByPatient.set(row.patient_id, row);
    }
  }
  const stillAtRisk = [...latestByPatient.values()]
    .filter((r) => Number(r.probability_compliant) < 0.5)
    .slice(0, 100);
  res.json({ predictions: stillAtRisk });
});

export default router;
