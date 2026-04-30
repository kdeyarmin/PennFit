// GET /patients/:id/notes — admin notes timeline for one patient.
//
// Returns up to the most recent 50 notes, newest first. The list is
// intentionally not paginated past 50 — notes are an operational
// memory aid, not a long-term archive, and the timeline UI on the
// patient detail page renders inline rather than virtualising.
//
// PHI: the note `body` is encrypted at rest and decrypted server-side
// before the response. The audit row records the patient_id and the
// number of rows returned, never the bodies.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { decrypt, getDbPool, patientNotes, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get("/patients/:id/notes", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const db = drizzle(getDbPool());

  // Verify the patient exists first so the dashboard's 404 surface
  // for a deleted patient is consistent with /patients/:id.
  const exists = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, id))
    .limit(1);
  if (exists.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const rows = await db
    .select({
      id: patientNotes.id,
      body: decrypt(patientNotes.body),
      authorEmail: patientNotes.authorEmail,
      authorUserId: patientNotes.authorUserId,
      createdAt: patientNotes.createdAt,
    })
    .from(patientNotes)
    .where(eq(patientNotes.patientId, id))
    .orderBy(desc(patientNotes.createdAt))
    .limit(50);

  await logAudit({
    action: "patient.notes.list",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "patients",
    targetId: id,
    metadata: { count: rows.length },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "patient.notes.list audit write failed");
  });

  res.json({
    notes: rows.map((r) => ({
      id: r.id,
      body: r.body ?? "",
      authorEmail: r.authorEmail,
      authorUserId: r.authorUserId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
