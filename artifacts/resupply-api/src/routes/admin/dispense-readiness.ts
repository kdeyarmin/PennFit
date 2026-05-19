// /admin/patients/:id/dispense-readiness-reviews
//
//   POST  — run the review for a given HCPCS + optional pre-resolved
//           coverage/payer. Persists the row + returns the full
//           findings + AI synthesis.
//   GET   — list the patient's prior reviews newest-first.
//   GET   /admin/patients/:id/dispense-readiness-reviews/:reviewId
//         — single review detail.
//   PATCH /admin/patients/:id/dispense-readiness-reviews/:reviewId
//         — mark review_status (acknowledged / remediated / overridden
//           / cancelled).
//
//   GET   /admin/dispense-readiness/queue — CSR queue of pending
//         reviews with gaps, across all patients.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  DISPENSE_PROMPT_VERSION,
  reviewDispenseReadiness,
} from "../../lib/billing/dispense-readiness-reviewer";
import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
} from "../../middlewares/requireAdmin";
import { publishEvent } from "../../lib/webhooks/publisher";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });
const reviewParams = z.object({
  id: z.string().uuid(),
  reviewId: z.string().uuid(),
});

const HCPCS_RE = /^[A-Z]\d{4}$/;

const runBody = z
  .object({
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .transform((s) => s.toUpperCase())
      .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
    fulfillmentId: z.string().uuid().nullable().optional(),
    payerProfileId: z.string().uuid().nullable().optional(),
    insuranceCoverageId: z.string().uuid().nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    reviewStatus: z.enum([
      "acknowledged",
      "remediated",
      "overridden",
      "cancelled",
    ]),
    /** Required when reviewStatus='overridden' — surveyors will ask
     *  why a CSR dispensed despite blocking errors. */
    overrideReason: z.string().trim().min(10).max(2000).optional(),
  })
  .strict()
  .refine(
    (b) => b.reviewStatus !== "overridden" || !!b.overrideReason,
    { message: "overrideReason required when reviewStatus='overridden'" },
  );

router.post(
  "/admin/patients/:id/dispense-readiness-reviews",
  requireAdmin,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = runBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    const out = await reviewDispenseReadiness({
      patientId: idParsed.data.id,
      hcpcsCode: b.hcpcsCode,
      fulfillmentId: b.fulfillmentId ?? null,
      payerProfileId: b.payerProfileId ?? null,
      insuranceCoverageId: b.insuranceCoverageId ?? null,
    });
    const supabase = getSupabaseServiceRoleClient();
    const insertRow: Database["resupply"]["Tables"]["dispense_readiness_reviews"]["Insert"] = {
      patient_id: idParsed.data.id,
      hcpcs_code: b.hcpcsCode,
      fulfillment_id: b.fulfillmentId ?? null,
      payer_profile_id: b.payerProfileId ?? null,
      insurance_coverage_id: b.insuranceCoverageId ?? null,
      ready_to_dispense: out.readyToDispense,
      overall_verdict: out.overallVerdict,
      estimated_days_to_ready: out.ai.estimatedDaysToReady,
      deterministic_findings_json: out.findings as unknown as Json,
      checks_total: out.counts.total,
      checks_passed: out.counts.passed,
      checks_warning: out.counts.warning,
      checks_failed: out.counts.failed,
      ai_summary: out.ai.summary,
      ai_action_plan_json: out.ai.actionPlan as unknown as Json,
      ai_model: "gpt-4o-mini",
      ai_prompt_version: DISPENSE_PROMPT_VERSION,
      ai_confidence: out.ai.confidence,
      ai_latency_ms: out.ai.latencyMs,
      ai_prompt_tokens: out.ai.promptTokens,
      ai_completion_tokens: out.ai.completionTokens,
      ai_error_message: out.ai.errorMessage,
      review_status: "pending",
      created_by_email: req.adminEmail ?? "unknown",
    };
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("dispense_readiness_reviews")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "dispense_readiness.review",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dispense_readiness_reviews",
      targetId: row.id,
      metadata: {
        patient_id: idParsed.data.id,
        hcpcs: b.hcpcsCode,
        verdict: out.overallVerdict,
        checks_total: out.counts.total,
        checks_failed: out.counts.failed,
        prompt_version: DISPENSE_PROMPT_VERSION,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "dispense_readiness.review audit write failed");
    });
    void publishEvent({
      eventType: "dispense_readiness.reviewed",
      payload: {
        review_id: row.id,
        patient_id: idParsed.data.id,
        verdict: out.overallVerdict,
        checks_failed: out.counts.failed,
      },
    });
    res.status(201).json({
      reviewId: row.id,
      readyToDispense: out.readyToDispense,
      overallVerdict: out.overallVerdict,
      counts: out.counts,
      findings: out.findings,
      ai: out.ai,
    });
  },
);

router.get(
  "/admin/patients/:id/dispense-readiness-reviews",
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
      .from("dispense_readiness_reviews")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ reviews: data ?? [] });
  },
);

router.get(
  "/admin/patients/:id/dispense-readiness-reviews/:reviewId",
  requireAdmin,
  async (req, res) => {
    const parsed = reviewParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("dispense_readiness_reviews")
      .select("*")
      .eq("id", parsed.data.reviewId)
      .eq("patient_id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ review: data });
  },
);

router.patch(
  "/admin/patients/:id/dispense-readiness-reviews/:reviewId",
  requireAdminOnly,
  async (req, res) => {
    const idParsed = reviewParams.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const b = parsed.data;
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("dispense_readiness_reviews")
      .update({
        review_status: b.reviewStatus,
        reviewed_by_email: req.adminEmail ?? "unknown",
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", idParsed.data.reviewId)
      .eq("patient_id", idParsed.data.id);
    if (error) throw error;
    await logAudit({
      action: "dispense_readiness.review_status_change",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dispense_readiness_reviews",
      targetId: idParsed.data.reviewId,
      metadata: {
        patient_id: idParsed.data.id,
        to_status: b.reviewStatus,
        override_reason: b.overrideReason ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "dispense_readiness.review_status_change audit write failed",
      );
    });
    res.json({ ok: true });
  },
);

router.get(
  "/admin/dispense-readiness/queue",
  requireAdmin,
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("dispense_readiness_reviews")
      .select(
        "id, patient_id, hcpcs_code, overall_verdict, estimated_days_to_ready, checks_failed, checks_warning, ai_summary, created_at",
      )
      .eq("review_status", "pending")
      .in("overall_verdict", ["gaps_with_fixable", "gaps_with_blocking"])
      .order("created_at", { ascending: false })
      .limit(200);
    const verdict =
      typeof req.query.verdict === "string" ? req.query.verdict : undefined;
    if (
      verdict &&
      ["gaps_with_fixable", "gaps_with_blocking"].includes(verdict)
    ) {
      query = query.eq(
        "overall_verdict",
        verdict as Database["resupply"]["Tables"]["dispense_readiness_reviews"]["Row"]["overall_verdict"],
      );
    }
    const { data } = await query;
    res.json({ reviews: data ?? [] });
  },
);

export default router;
