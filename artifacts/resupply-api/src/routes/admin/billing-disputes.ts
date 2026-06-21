// GET /admin/billing/disputes — chargeback dispute worklist.
//
// Reads resupply.stripe_disputes (migration 0428), which the Stripe
// charge.dispute.* webhook now upserts into. Open disputes first, ordered by
// evidence deadline so the deadline-bearing ones surface — the whole point of
// persisting disputes instead of only WARN-logging them.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const query = z
  .object({
    status: z.enum(["open", "all"]).optional().default("open"),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  })
  .strict();

router.get(
  "/admin/billing/disputes",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    let q = supabase
      .from("stripe_disputes")
      .select(
        "id, stripe_dispute_id, stripe_charge_id, order_id, amount_cents, currency, reason, status, evidence_due_by, opened_at, closed_at, outcome",
      )
      .order("evidence_due_by", { ascending: true, nullsFirst: false })
      .limit(parsed.data.limit);
    if (parsed.data.status === "open") {
      q = q.is("closed_at", null);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ disputes: data ?? [] });
  },
);

export default router;
