// /admin/eligibility-checks — 270/271 round-trip surface.
//
//   POST /admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility
//        — fire a 270 against the payer.
//   GET  /admin/patients/:id/eligibility-checks
//        — most recent checks for a patient.

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { verifyEligibility } from "../../lib/billing/eligibility-verifier";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const verifyEligibilityRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyParams = z.object({
  id: z.string().uuid(),
  coverageId: z.string().uuid(),
});
const verifyBody = z
  .object({ hcpcsCode: z.string().regex(/^[A-Z]\d{4}$/).optional() })
  .strict()
  .optional();

router.post(
  "/admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility",
  requirePermission("patients.update"),
  verifyEligibilityRateLimiter,
  async (req, res) => {
    const parsed = verifyParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = verifyBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    try {
      const result = await verifyEligibility({
        insuranceCoverageId: parsed.data.coverageId,
        hcpcsCode: bodyParsed.data?.hcpcsCode,
        requestedByEmail: req.adminEmail ?? "unknown",
      });
      await logAudit({
        action: "eligibility.verify",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "eligibility_checks",
        targetId: result.eligibilityCheckId,
        metadata: {
          patient_id: parsed.data.id,
          coverage_id: parsed.data.coverageId,
          hcpcs: bodyParsed.data?.hcpcsCode ?? null,
          upload_ok: result.uploadOk,
          trace: result.traceReference,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "eligibility.verify audit write failed");
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "eligibility.verify failed");
      res.status(409).json({ error: "verify_failed", message: msg });
    }
  },
);

router.get(
  "/admin/patients/:id/eligibility-checks",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("eligibility_checks")
      .select("*")
      .eq("patient_id", parsed.data.id)
      .order("requested_at", { ascending: false })
      .limit(50);
    res.json({ checks: data ?? [] });
  },
);

export default router;
