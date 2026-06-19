// /admin/patients/:id/refill-confirmations — read the beneficiary's
// Medicare/payer refill attestations (continued use + supply running low)
// captured at each resupply confirm. This is the audit-grade proof a
// payer or auditor asks for to substantiate a refill claim.
//
//   GET /admin/patients/:id/refill-confirmations
//       — most recent refill attestations for a patient.
//
// Read-only: the rows are written by the order-confirm flow
// (lib/messaging/order-flow.ts), never by an admin.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/patients/:id/refill-confirmations",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Fail closed: never widen to all tenants on a missing orgId.
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const db = getOrgScopedClient(orgId);
    const { data } = await db
      .from("refill_confirmations")
      .select(
        "id, episode_id, prescription_id, item_sku, hcpcs_code, channel, " +
          "affirm_continued_use, affirm_supply_low, attestation_text, " +
          "requested_by, expected_depletion_on, confirmed_at",
      )
      .eq("patient_id", parsed.data.id)
      .order("confirmed_at", { ascending: false })
      .limit(100);
    res.json({ confirmations: data ?? [] });
  },
);

export default router;
