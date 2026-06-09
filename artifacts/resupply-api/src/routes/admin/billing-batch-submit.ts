// POST /admin/billing/batch-submit-office-ally
//
// Bulk-submit N draft claims in a single 837P interchange envelope.
// Massive cost win vs. one-file-per-claim: Office Ally's file
// management overhead is per-file, not per-claim, and ops teams batch
// 25-100 claims per upload as the industry-standard pattern.
//
// Body: { claimIds: string[], usageIndicator?: "P" | "T" }
//
// Preconditions enforced per claim (in executeOfficeAllyBatchSubmit):
//   * status === 'draft'
//   * payer_profile_id set + electronically billable + EDI-enrolled
//   * insurance_coverage_id + line items present
//   * patient address structured
//   * payer_profile_id is the SAME across all claims in the batch
//     (one 837P interchange = one receiver = one payer)
//
// The core logic lives in `lib/billing/office-ally-batch.ts` so the
// new `POST /admin/office-ally-submissions/:id/resubmit` flow reuses
// the same preflight + build + transport + persistence sequence.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { executeOfficeAllyBatchSubmit } from "../../lib/billing/office-ally-batch";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const body = z
  .object({
    claimIds: z.array(z.string().uuid()).min(1).max(100),
    usageIndicator: z.enum(["P", "T"]).optional(),
  })
  .strict();

router.post(
  "/admin/billing/batch-submit-office-ally",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "billing.batch_submit_office_ally", preset: "bulk" }),
  async (req, res) => {
    const parsed = body.safeParse(req.body);
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

    const result = await executeOfficeAllyBatchSubmit({
      claimIds: parsed.data.claimIds,
      usageIndicator: parsed.data.usageIndicator,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (!result.ok) {
      const status =
        result.kind === "no_claims_matched"
          ? 404
          : result.kind === "some_claims_not_found" ||
              result.kind === "batch_payer_mismatch" ||
              result.kind === "non_draft_claims_in_batch" ||
              result.kind === "payer_not_electronic" ||
              result.kind === "claim_missing_required_data" ||
              result.kind === "eligibility_blocked" ||
              result.kind === "bill_hold"
            ? 409
            : 400;
      res.status(status).json({ error: result.kind, ...result.detail });
      return;
    }

    res.status(result.uploadOk ? 201 : 502).json({
      ok: result.uploadOk,
      submissionId: result.submissionId,
      claimCount: result.claimCount,
      isaControlNumber: result.isaControlNumber,
      gsControlNumber: result.gsControlNumber,
      fileSizeBytes: result.fileSizeBytes,
      transport: result.transport,
      uploadError: result.uploadError,
    });
  },
);

export default router;
