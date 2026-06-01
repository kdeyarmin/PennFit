// POST /admin/patients/:id/insurance-claims/:claimId/explain-denial
//
// Generates a patient-friendly explanation email for a denied
// claim. Returns the subject + body the CSR copies into the email
// composer (or, in a follow-up, the route sends directly via
// SendGrid using the existing email infra).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logAudit } from "@workspace/resupply-audit";

import {
  EXPLAINER_PROMPT_VERSION,
  explainDenialToPatient,
} from "../../lib/billing/ai-denial-patient-explainer";
import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

router.post(
  "/patients/:id/insurance-claims/:claimId/explain-denial",
  requireAdmin,
  adminWriteRateLimiter,
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Scope the claim to the patient in the path. explainDenialToPatient()
    // looks the claim up by id only, so a mismatched :id / :claimId would
    // otherwise generate an explanation for another patient's claim (IDOR).
    const supabase = getSupabaseServiceRoleClient();
    const { data: owned, error: ownErr } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id")
      .eq("id", parsed.data.claimId)
      .eq("patient_id", parsed.data.id)
      .maybeSingle();
    if (ownErr) throw ownErr;
    if (!owned) {
      res.status(404).json({ error: "claim_not_found" });
      return;
    }
    const result = await explainDenialToPatient({
      claimId: parsed.data.claimId,
    });
    await logAudit({
      action: "insurance_claim.explain_denial_to_patient",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: parsed.data.claimId,
      metadata: {
        patient_id: parsed.data.id,
        tone: result.tone,
        prompt_version: EXPLAINER_PROMPT_VERSION,
        latency_ms: result.latencyMs,
        had_error: result.errorMessage !== null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.explain_denial_to_patient audit write failed",
      );
    });
    res.json({
      subject: result.subject,
      body: result.body,
      tone: result.tone,
      latencyMs: result.latencyMs,
      promptVersion: EXPLAINER_PROMPT_VERSION,
    });
  },
);

export default router;
