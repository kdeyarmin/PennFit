// POST /patients/merge — fold a duplicate patient record into a primary
// (CSR #C1, merge half). Pairs with GET /patients/duplicates (detection).
//
// The actual cross-table repoint is done atomically by the
// resupply.merge_patient_records RPC (migration 0225): it repoints every
// FK referencing patients(id) from the duplicate to the primary and marks
// the duplicate merged, all-or-nothing. This route validates input, calls
// the RPC, and maps its RAISEd SQLSTATEs to clean HTTP statuses.
//
// Gated by patients.update — the same permission that guards editing a
// patient. Destructive but recoverable (the duplicate is closed, not
// deleted, with a merged_into_patient_id pointer).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const bodySchema = z
  .object({
    primaryPatientId: z.string().uuid(),
    duplicatePatientId: z.string().uuid(),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/patients/merge",
  requirePermission("patients.update"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
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
    const { primaryPatientId, duplicatePatientId } = parsed.data;
    if (primaryPatientId === duplicatePatientId) {
      res.status(400).json({ error: "same_patient" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("merge_patient_records", {
        p_primary: primaryPatientId,
        p_duplicate: duplicatePatientId,
      });

    if (error) {
      const code = (error as { code?: string }).code;
      switch (code) {
        case "23505":
          // A one-row-per-patient child exists for BOTH records — the
          // whole merge rolled back. The CSR must reconcile by hand.
          res.status(409).json({ error: "merge_conflict" });
          return;
        case "P0001":
          res.status(400).json({ error: "same_patient" });
          return;
        case "P0002":
          res.status(404).json({ error: "patient_not_found" });
          return;
        case "P0003":
          res.status(409).json({ error: "already_merged" });
          return;
        default:
          throw error;
      }
    }

    logger.info(
      {
        event: "patients.merge.completed",
        primaryPatientId,
        duplicatePatientId,
        // RPC returns { tablesRepointed, rowsRepointed } — counts only.
        summary: data,
      },
      "patients: merge completed",
    );
    res.json({ ok: true, ...(data as Record<string, unknown>) });
  },
);

export default router;
