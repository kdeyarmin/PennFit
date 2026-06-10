// POST /admin/patients/:id/sleep-studies/:studyId/suggest-icd10
//
// Runs the AI ICD-10 suggester against a sleep study + (optionally)
// applies the suggestion to the row in 'ai_suggested' state. The
// CSR review endpoint at /sleep-studies/:id/accept-icd10 flips it
// to 'ai_accepted'.
//
// Body: { autoApply?: boolean, requireConfidence?: number }

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  ICD10_PROMPT_VERSION,
  suggestIcd10,
} from "../../lib/clinical/ai-icd10-suggester";
import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
});

const body = z
  .object({
    autoApply: z.boolean().default(false),
    /** Floor on confidence required for autoApply. Default 0.9. */
    requireConfidence: z.number().min(0).max(1).default(0.9),
  })
  .strict()
  .optional();

router.post(
  "/patients/:id/sleep-studies/:studyId/suggest-icd10",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = body.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: study } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("id, patient_id, diagnosis_icd10")
      .eq("id", idParsed.data.studyId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!study) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const out = await suggestIcd10({ sleepStudyId: study.id });

    const shouldApply =
      bodyParsed.data?.autoApply &&
      out.inAllowlist &&
      out.icd10 !== null &&
      out.confidence >= (bodyParsed.data?.requireConfidence ?? 0.9);

    // `applied` reflects whether we ACTUALLY wrote the code. autoApply is
    // a no-op when the study already carries a diagnosis; reporting
    // applied:true there would mislead the CSR and the audit row.
    const applied = shouldApply && !study.diagnosis_icd10;
    if (applied) {
      // If this write fails, reporting applied:true (and the audit row)
      // would be a lie — fail the request instead.
      const { error: applyErr } = await supabase
        .schema("resupply")
        .from("sleep_studies")
        .update({
          diagnosis_icd10: out.icd10,
          diagnosis_source: "ai_suggested",
          diagnosis_ai_confidence: out.confidence,
          diagnosis_ai_model: "gpt-4o-mini",
          diagnosis_ai_suggested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", study.id);
      if (applyErr) throw applyErr;
    }

    await logAudit({
      action: "sleep_study.ai_icd10_suggest",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "sleep_studies",
      targetId: study.id,
      metadata: {
        patient_id: study.patient_id,
        suggested_code: out.icd10,
        confidence: out.confidence,
        in_allowlist: out.inAllowlist,
        applied,
        prompt_version: ICD10_PROMPT_VERSION,
        had_error: out.errorMessage !== null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "sleep_study.ai_icd10_suggest audit write failed");
    });

    res.json({
      icd10: out.icd10,
      confidence: out.confidence,
      rationale: out.rationale,
      inAllowlist: out.inAllowlist,
      applied,
      promptVersion: ICD10_PROMPT_VERSION,
    });
  },
);

router.post(
  "/patients/:id/sleep-studies/:studyId/accept-icd10",
  adminWriteRateLimiter,
  requireAdmin,
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: study } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("id, diagnosis_source, diagnosis_icd10")
      .eq("id", idParsed.data.studyId)
      .eq("patient_id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!study) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (study.diagnosis_source !== "ai_suggested") {
      res.status(409).json({
        error: "invalid_state",
        message: "study diagnosis is not in ai_suggested state",
      });
      return;
    }
    const { error: acceptErr } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .update({
        diagnosis_source: "ai_accepted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", study.id);
    if (acceptErr) throw acceptErr;
    await logAudit({
      action: "sleep_study.ai_icd10_accept",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "sleep_studies",
      targetId: study.id,
      metadata: { icd10: study.diagnosis_icd10 },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "sleep_study.ai_icd10_accept audit write failed");
    });
    res.json({ ok: true });
  },
);

export default router;
