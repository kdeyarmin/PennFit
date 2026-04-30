// POST /patients/:id/notes — admin appends a free-text note.
//
// Notes are append-only. There is no PATCH/DELETE endpoint by design:
// a note is a record of "this is what an admin observed at this
// moment", and rewriting history defeats its operational purpose.
//
// PHI: the body almost certainly carries PHI (call summaries quote
// the patient verbatim, family situation, etc). Encrypt at write,
// never log the plaintext, and never echo it back into the audit
// metadata.

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { encrypt, getDbPool, patientNotes, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
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

router.post("/patients/:id/notes", requireAdmin, async (req, res) => {
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

  const db = drizzle(getDbPool());

  // Verify patient exists. We could rely on the FK to fire a 23503
  // here, but a pre-check yields a cleaner 404 vs. 500 mapping.
  const exists = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (exists.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const inserted = await db
    .insert(patientNotes)
    .values({
      patientId,
      body: sql`${encrypt(body)}`,
      authorEmail: req.adminEmail ?? "<unknown>",
      authorUserId: req.adminUserId ?? null,
    })
    .returning({ id: patientNotes.id, createdAt: patientNotes.createdAt });

  const row = inserted[0];
  if (!row) {
    throw new Error("INSERT returned no rows");
  }

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
    createdAt: row.createdAt.toISOString(),
  });
});

export default router;
