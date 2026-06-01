// POST /patients/:id/notes — admin appends a free-text note.
//
// Notes are append-only. There is no PATCH/DELETE endpoint by design:
// a note is a record of "this is what an admin observed at this
// moment", and rewriting history defeats its operational purpose.
//
// PHI: the body almost certainly carries PHI (call summaries quote
// the patient verbatim, family situation, etc). Stored as plaintext
// text post-migration 0025; never log the plaintext, and never echo
// it back into the audit metadata.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const bodySchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Note body cannot be empty.")
      .max(4000, "Note body must be 4000 characters or fewer."),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/patients/:id/notes",
  requireAdmin,
  adminWriteRateLimiter,
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const bodyParsed = bodySchema.safeParse(req.body);
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

    const { id: patientId } = idParsed.data;
    const { body } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Verify patient exists. We could rely on the FK to fire a 23503
    // here, but a pre-check yields a cleaner 404 vs. 500 mapping.
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("patient_notes")
      .insert({
        patient_id: patientId,
        body,
        author_email: req.adminEmail ?? "<unknown>",
        author_user_id: req.adminUserId ?? null,
      })
      .select("id, created_at")
      .single();
    if (error) throw error;

    await logAudit({
      action: "patient.note.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_notes",
      targetId: row.id,
      // Structural metadata only. body_length lets reviewers spot
      // suspiciously long pastes without exposing the contents.
      metadata: { patient_id: patientId, body_length: body.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.note.create audit write failed");
    });

    res.status(201).json({
      id: row.id,
      createdAt: row.created_at,
    });
  },
);

export default router;
