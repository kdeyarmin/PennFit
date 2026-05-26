// GET /admin/patients/:id/insurance-claims/:claimId/preflight
//
// Returns the structured readiness checklist for a draft claim — the
// CSR sees exactly what's blocking submission and gets a deep-link
// hint to fix each row. The submit-office-ally endpoint's existing
// guards remain the source of truth; this is the UX layer.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { preflightClaim } from "../../lib/billing/claim-preflight";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

router.get(
  "/patients/:id/insurance-claims/:claimId/preflight",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Scope the claim to the patient in the path. Without this, a
    // mismatched :id / :claimId pairing would return another patient's
    // claim preflight (ICD-10 diagnosis, payer, HCPCS lines) — an IDOR.
    // preflightClaim() looks the claim up by id only, so we gate here.
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
    const summary = await preflightClaim(parsed.data.claimId);
    res.json({ preflight: summary });
  },
);

export default router;
