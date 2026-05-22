// POST /admin/patients/:id/insurance-claims/:claimId/submit-office-ally
//
// Single-claim convenience wrapper around the shared Office Ally
// batch core. A batch of one is functionally identical to the
// per-claim flow this endpoint used to implement inline, so the
// single-claim route just builds a 1-element batch and delegates.
//
// Why delegate vs the previous inline implementation:
//   * One source of truth for preflight + EDI build + transport +
//     persistence. Adding a guard (edi_enrollment_status, COB, etc)
//     in one place updates both single-claim and batch paths.
//   * Inherits `attempted_claim_ids` tracking so a transport_failed
//     single-claim submit can be one-click resubmitted from the OA
//     Operations dashboard (migration 0150).
//   * Inherits `parent_submission_id` for resubmit lineage.
//
// State machine guards that USED to live here are now enforced in
// the batch core:
//   - claim.status === 'draft'
//   - payer is active, electronic (non-paper), has office_ally_payer_id,
//     and is edi_enrollment_status='enrolled'
//   - claim has insurance_coverage_id + >= 1 line item
//   - patient address is structured
//
// A handful of single-claim-specific guards stay here:
//   - 404 when claim isn't owned by the URL patient (defense in depth
//     for the URL routing — the batch core trusts the caller).
//   - 409 when the claim already has an office_ally_submission_id
//     (already submitted; the batch core won't see this because
//     the status guard fires first, but the message is friendlier).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { executeOfficeAllyBatchSubmit } from "../../lib/billing/office-ally-batch";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

const submitBody = z
  .object({
    usageIndicator: z.enum(["P", "T"]).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .optional();

router.post(
  "/patients/:id/insurance-claims/:claimId/submit-office-ally",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const idParsed = params.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const bodyParsed = submitBody.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    // Defense-in-depth: confirm the claim belongs to this patient
    // before delegating. The batch core looks up claims purely by id,
    // so without this an admin URL-fuzzing could submit one patient's
    // claim under another patient's path. We also surface
    // `already_submitted` as a friendlier 409 here.
    const supabase = getSupabaseServiceRoleClient();
    const { data: claim } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select("id, patient_id, office_ally_submission_id")
      .eq("id", idParsed.data.claimId)
      .limit(1)
      .maybeSingle();
    if (!claim || claim.patient_id !== idParsed.data.id) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (claim.office_ally_submission_id) {
      res.status(409).json({
        error: "already_submitted",
        message: "claim already linked to an Office Ally submission",
      });
      return;
    }

    const result = await executeOfficeAllyBatchSubmit({
      claimIds: [claim.id],
      usageIndicator: bodyParsed.data?.usageIndicator,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (!result.ok) {
      // Map the batch core's discriminated-union failures into HTTP.
      // The single-claim path historically returned 400 for missing
      // payer/coverage/etc; mirror that.
      const status =
        result.kind === "no_claims_matched"
          ? 404
          : result.kind === "non_draft_claims_in_batch"
            ? 409
            : result.kind === "payer_not_electronic"
              ? 409
              : result.kind === "claim_missing_required_data"
                ? 400
                : 409;
      res.status(status).json({ error: result.kind, ...result.detail });
      return;
    }

    // Upload may have failed at the transport layer even when the
    // batch core returned ok:true (it created the
    // office_ally_submissions row with status='transport_failed').
    // Surface as 502 so the UI can show "retry" affordance.
    if (!result.uploadOk) {
      res.status(502).json({
        ok: false,
        error: "upload_failed",
        message: result.uploadError,
        submissionId: result.submissionId,
        isaControlNumber: result.isaControlNumber,
      });
      return;
    }
    res.status(201).json({
      ok: true,
      submissionId: result.submissionId,
      isaControlNumber: result.isaControlNumber,
      gsControlNumber: result.gsControlNumber,
      claimCount: result.claimCount,
      fileSizeBytes: result.fileSizeBytes,
      transport: result.transport,
    });
  },
);

export default router;
