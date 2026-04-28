// DELETE /rules/:id — hard-delete a rule.
//
// Rules carry no PHI and have no foreign-key children, so a hard
// delete is safe. Operators who want to keep a rule's history but
// stop applying it should toggle `active` instead — the dashboard
// makes both options easy.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { frequencyRules, getDbPool } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireOperator } from "../../middlewares/requireOperator";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.delete("/rules/:id", requireOperator, async (req, res) => {
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
      operatorEmail: req.operatorEmail ?? null,
      operatorClerkId: req.operatorClerkId ?? null,
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
