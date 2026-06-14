// Biller #28 — secondary / coordination-of-benefits claims.
//
//   GET  /admin/billing/secondary-eligible   (reports.read)
//     Primary claims the primary payer has PAID that carry a secondary
//     coverage + a patient-responsibility balance, and don't yet have a
//     secondary claim. The biller's COB worklist.
//
//   POST /admin/claims/:id/generate-secondary (admin.tools.manage)
//     Roll the balance the primary left to the secondary payer: create a
//     new 'secondary' claim (same services / line items) carrying a
//     SNAPSHOT of the primary's adjudication (paid / contractual / patient
//     responsibility) for the 837 2320/2330 COB loop. Status 'draft' — the
//     biller reviews + submits through the normal batch path.
//
// The COB math + claim creation live in a shared, unit-tested helper
// (lib/billing/secondary-claim-generator) so the auto-workflow engine can
// draft secondaries on the same path. PHI posture: money + ids only in
// logs — never patient detail.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  filterSecondaryEligible,
  generateSecondaryClaimDraft,
  SECONDARY_CLAIM_SELECT as CLAIM_SELECT,
  type EligibleCandidate,
} from "../../lib/billing/secondary-claim-generator";

// Re-export the pure COB helpers + types from the shared module so existing
// importers (tests, callers) keep their `./secondary-claims` import path.
export {
  deriveSecondaryCob,
  filterSecondaryEligible,
  type CobDerivation,
  type EligibleCandidate,
  type EligibleItem,
  type PrimaryClaimTotals,
} from "../../lib/billing/secondary-claim-generator";

const router: IRouter = Router();

router.get(
  "/admin/billing/secondary-eligible",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const candRes = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(CLAIM_SELECT)
      .eq("payer_sequence", "primary")
      .eq("status", "paid")
      .not("secondary_coverage_id", "is", null)
      .order("patient_responsibility_cents", { ascending: false })
      .limit(500);
    if (candRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: candRes.error.message });
      return;
    }
    const candidates = (candRes.data ?? []) as unknown as EligibleCandidate[];

    // Which of these primaries already have a secondary?
    const ids = candidates.map((c) => c.id);
    const existing = new Set<string>();
    if (ids.length > 0) {
      const secRes = await supabase
        .schema("resupply")
        .from("insurance_claims")
        .select("primary_claim_id")
        .eq("payer_sequence", "secondary")
        .in("primary_claim_id", ids);
      if (secRes.error) {
        res
          .status(500)
          .json({ error: "query_failed", message: secRes.error.message });
        return;
      }
      for (const r of (secRes.data ?? []) as Array<{
        primary_claim_id?: string | null;
      }>) {
        if (r.primary_claim_id) existing.add(r.primary_claim_id);
      }
    }

    const items = filterSecondaryEligible(candidates, existing);
    res.json({ eligible: items, count: items.length });
  },
);

const idParam = z.string().uuid();

router.post(
  "/admin/claims/:id/generate-secondary",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_claim_id" });
      return;
    }
    const primaryId = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const result = await generateSecondaryClaimDraft(supabase, primaryId);
    switch (result.status) {
      case "not_found":
        res.status(404).json({ error: "claim_not_found" });
        return;
      case "not_eligible":
        res.status(409).json({ error: result.reason });
        return;
      case "exists":
        res.status(409).json({
          error: "secondary_exists",
          secondaryClaimId: result.secondaryClaimId,
        });
        return;
      case "query_failed":
        res.status(500).json({ error: "query_failed", message: result.message });
        return;
      case "create_failed":
        res.status(500).json({ error: "secondary_create_failed" });
        return;
      case "line_copy_failed":
        res.status(500).json({
          error: "line_copy_failed",
          secondaryClaimId: result.secondaryClaimId,
          message: result.message,
        });
        return;
      case "created":
        req.log?.info(
          {
            event: "admin.secondary_claim.generated",
            primary_claim_id: primaryId,
            secondary_claim_id: result.secondaryClaimId,
            line_count: result.lineCount,
            adminEmail: req.adminEmail,
          },
          "admin.secondary_claim.generated",
        );
        res.status(201).json({
          secondaryClaimId: result.secondaryClaimId,
          cob: result.cob,
          lineCount: result.lineCount,
        });
        return;
    }
  },
);

export default router;
