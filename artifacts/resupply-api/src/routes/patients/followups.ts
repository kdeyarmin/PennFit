// /patients/:id/followups — CSR-scheduled callback reminders per
// patient (Phase 19). Mirrors /admin/shop/customers/:userId/followups
// (Phase 17) for the patient flow.
//
//   GET    /patients/:id/followups          — list (open only)
//   GET    /patients/:id/followups?include=completed — full history
//   POST   /patients/:id/followups          — create
//   PATCH  /patients/:id/followups/:fid/complete — mark complete
//
// Mounted under /patients/* (the resupply patient flow's prefix), not
// /admin/shop/* — patients and shop customers are distinct identity
// surfaces and the FK targets are different tables.
//
// PHI / log posture: bodies are plain text and may carry PHI (call
// summary, family context). Audit envelopes record patient_id +
// body_length + due_at — never the body. Same posture as patient_notes.

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getDbPool, patientFollowups, patients } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const patientIdParam = z.string().uuid();
const followupIdParam = z.string().uuid();

const createSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Followup body cannot be empty.")
      .max(2000, "Followup body must be 2000 characters or fewer."),
    dueAt: z
      .string()
      .datetime({ message: "dueAt must be an ISO 8601 timestamp." }),
  })
  .strict();

router.get("/patients/:id/followups", requireAdmin, async (req, res) => {
  const parsed = patientIdParam.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const patientId = parsed.data;
  const includeCompleted = req.query.include === "completed";

  const db = drizzle(getDbPool());

  const exists = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (exists.length === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const rows = await db
    .select({
      id: patientFollowups.id,
      body: patientFollowups.body,
      dueAt: patientFollowups.dueAt,
      completedAt: patientFollowups.completedAt,
      completedByEmail: patientFollowups.completedByEmail,
      createdByEmail: patientFollowups.createdByEmail,
      createdAt: patientFollowups.createdAt,
    })
    .from(patientFollowups)
    .where(
      includeCompleted
        ? eq(patientFollowups.patientId, patientId)
        : and(
            eq(patientFollowups.patientId, patientId),
            isNull(patientFollowups.completedAt),
          ),
    )
    .orderBy(
      includeCompleted
        ? desc(patientFollowups.dueAt)
        : asc(patientFollowups.dueAt),
    )
    .limit(100);

  req.log?.info(
    {
      patientId,
      count: rows.length,
      includeCompleted,
      adminEmail: req.adminEmail,
    },
    "patient.followups.list",
  );

  res.json({
    followups: rows.map((r) => ({
      id: r.id,
      body: r.body,
      dueAt: r.dueAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      completedByEmail: r.completedByEmail,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

router.post("/patients/:id/followups", requireAdmin, async (req, res) => {
  const parsed = patientIdParam.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const patientId = parsed.data;

  const bodyParsed = createSchema.safeParse(req.body);
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
  const { body, dueAt } = bodyParsed.data;

  const db = drizzle(getDbPool());

  const exists = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, patientId))
    .limit(1);
  if (exists.length === 0) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }

  const inserted = await db
    .insert(patientFollowups)
    .values({
      patientId,
      body,
      dueAt: new Date(dueAt),
      createdByEmail: req.adminEmail ?? "<unknown>",
      createdByUserId: req.adminUserId ?? null,
    })
    .returning({
      id: patientFollowups.id,
      createdAt: patientFollowups.createdAt,
      dueAt: patientFollowups.dueAt,
    });
  const row = inserted[0];
  if (!row) {
    throw new Error("INSERT returned no rows");
  }

  await logAudit({
    action: "patient.followup.create",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "patient_followups",
    targetId: row.id,
    metadata: {
      patient_id: patientId,
      body_length: body.length,
      due_at: row.dueAt.toISOString(),
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "patient.followup.create audit write failed");
  });

  res.status(201).json({
    id: row.id,
    dueAt: row.dueAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
});

router.patch(
  "/patients/:id/followups/:fid/complete",
  requireAdmin,
  async (req, res) => {
    const parsed = patientIdParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const patientId = parsed.data;

    const fIdCheck = followupIdParam.safeParse(req.params.fid);
    if (!fIdCheck.success) {
      res.status(400).json({ error: "invalid_followup_id" });
      return;
    }
    const followupId = fIdCheck.data;

    const db = drizzle(getDbPool());

    const existing = await db
      .select({
        id: patientFollowups.id,
        patientId: patientFollowups.patientId,
        completedAt: patientFollowups.completedAt,
        body: patientFollowups.body,
      })
      .from(patientFollowups)
      .where(eq(patientFollowups.id, followupId))
      .limit(1);
    const row = existing[0];
    if (!row) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    if (row.patientId !== patientId) {
      res.status(404).json({ error: "followup_not_found" });
      return;
    }
    if (row.completedAt !== null) {
      res.status(409).json({
        error: "already_completed",
        message: "This followup is already marked complete.",
      });
      return;
    }

    const updated = await db
      .update(patientFollowups)
      .set({
        completedAt: new Date(),
        completedByEmail: req.adminEmail ?? "<unknown>",
        completedByUserId: req.adminUserId ?? null,
      })
      .where(eq(patientFollowups.id, followupId))
      .returning({
        id: patientFollowups.id,
        completedAt: patientFollowups.completedAt,
      });
    const updatedRow = updated[0];
    if (!updatedRow) {
      throw new Error("UPDATE returned no rows");
    }

    await logAudit({
      action: "patient.followup.complete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_followups",
      targetId: followupId,
      metadata: {
        patient_id: patientId,
        body_length: row.body.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.followup.complete audit write failed");
    });

    res.json({
      id: updatedRow.id,
      completedAt: updatedRow.completedAt
        ? updatedRow.completedAt.toISOString()
        : null,
    });
  },
);

export default router;
