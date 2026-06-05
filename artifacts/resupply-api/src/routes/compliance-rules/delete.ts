// DELETE /compliance-rules/:id — hard-delete a compliance rule.
//
// Rules carry no PHI and have no FK children, so a hard delete is safe.
// As with /rules, deleting is gated on `requireAdminOnly` (403s agents)
// because it is not safely reversible by a CSR — admins who want to keep
// history should toggle `active` instead. Note: deleting the seeded CMS
// default makes every unmatched patient fall back to the resolver's
// built-in 240/21, so behavior is unchanged even then.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.delete("/compliance-rules/:id", requireAdminOnly, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("compliance_rules")
    .delete()
    .eq("id", parsed.data.id)
    .select("id, name");
  if (error) throw error;

  if (!data || data.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    await logAudit({
      action: "compliance_rules.delete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "compliance_rules",
      targetId: parsed.data.id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { ruleName: data[0]!.name },
    });
  } catch (err) {
    logger.error(
      {
        err:
          err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      "compliance_rules.delete: audit write failed",
    );
  }

  res.status(204).end();
});

export default router;
