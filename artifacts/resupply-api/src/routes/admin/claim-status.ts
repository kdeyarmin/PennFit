// /admin/.../status-check[s] — X12 276/277 claim-status inquiry (biller
// #B3). Lets a biller proactively ask "where's my claim?" instead of
// waiting for the ERA.
//
//   POST /admin/patients/:id/insurance-claims/:claimId/status-check
//        patients.update — build + transmit a 276, record the check.
//   GET  /admin/patients/:id/insurance-claims/:claimId/status-checks
//        patients.read — list this claim's prior checks + parsed results.
//
// The 277 response is ingested asynchronously by the Office Ally poller
// (case "277" → dispatch277), which flips the row to status='parsed'
// with the category/status codes + amounts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  ClaimNotForPatientError,
  submitClaimStatusCheck,
} from "../../lib/billing/claim-status-checker";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

router.post(
  "/admin/patients/:id/insurance-claims/:claimId/status-check",
  requirePermission("patients.update"),
  adminRateLimit({ name: "claim_status.check", preset: "sensitive" }),
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const result = await submitClaimStatusCheck({
        claimId: parsed.data.claimId,
        patientId: parsed.data.id,
        requestedByEmail: req.adminEmail ?? "unknown",
      });
      await logAudit({
        action: "claim_status.check_submitted",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "claim_status_checks",
        targetId: result.claimStatusCheckId,
        metadata: {
          claim_id: parsed.data.claimId,
          isa_control_number: result.isaControlNumber,
          upload_ok: result.uploadOk,
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "claim_status.check_submitted audit write failed");
      });
      res.status(201).json({
        id: result.claimStatusCheckId,
        uploadOk: result.uploadOk,
        errorMessage: result.errorMessage,
      });
    } catch (err) {
      if (err instanceof ClaimNotForPatientError) {
        res.status(404).json({ error: "claim_not_found" });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "insurance_claim not found" || msg === "patient not found") {
        res.status(404).json({ error: "claim_not_found" });
        return;
      }
      if (msg.startsWith("payer does not accept")) {
        res.status(422).json({ error: "payer_not_electronic" });
        return;
      }
      throw err;
    }
  },
);

router.get(
  "/admin/patients/:id/insurance-claims/:claimId/status-checks",
  adminReadRateLimiter,
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("claim_status_checks")
      .select(
        "id, status, outcome, category_code, status_code, total_charge_cents, total_paid_cents, requested_at, responded_at, error_message",
      )
      .eq("claim_id", parsed.data.claimId)
      .order("requested_at", { ascending: false })
      .limit(50);
    res.json({ statusChecks: data ?? [] });
  },
);

export default router;
