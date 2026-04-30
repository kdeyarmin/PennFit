// DELETE /rules/:id — hard-delete a rule.
//
// Rules carry no PHI and have no foreign-key children, so a hard
// delete is safe. Admins who want to keep a rule's history but
// stop applying it should toggle `active` instead — the dashboard
// makes both options easy.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { frequencyRules, getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdminOnly } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

// Hard-deleting a cadence rule is one of the few resupply-admin
// actions that is NOT safely reversible by a customer-service
// agent: once gone, we lose the rule definition (admins who want
// to keep history should toggle `active` instead). We therefore
// gate this route on `requireAdminOnly`, which 403s callers whose
// `req.adminRole === "agent"`. All other rule routes (create,
// update, toggle) remain on the standard `requireAdmin`.
router.delete("/rules/:id", requireAdminOnly, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const db = drizzle(getDbPool());
  const result = await db
    .delete(frequencyRules)
    .where(eq(frequencyRules.id, parsed.data.id))
    .returning({ id: frequencyRules.id, name: frequencyRules.name });

  if (result.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  try {
    await logAudit({
      action: "rules.delete",
      adminEmail: req.adminEmail ?? null,
      adminClerkId: req.adminClerkId ?? null,
      targetTable: "frequency_rules",
      targetId: parsed.data.id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { name: result[0].name },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "rules.delete: audit write failed",
    );
  }

  res.status(204).end();
});

export default router;
