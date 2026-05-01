// POST /patients/:id/prescriptions — admin records a new doctor's
// order for a patient.
//
// What this route owns:
//   - Validation of the prescription body (SKU, cadence, validity
//     window, optional doctor metadata).
//   - Storing the prescriber-narrative `details` JSON in the
//     plaintext jsonb column.
//   - One audit row per create, with field-name list only — never
//     the field values.
//
// What this route does NOT own:
//   - Editing an existing prescription's clinical fields. Once an
//     active prescription is on file, the clinical record is
//     immutable; the only legal mutation is a status transition
//     to `expired` or `revoked`, which lives in
//     prescriptions-update.ts. This is a deliberate provenance
//     decision — the dashboard should never let one admin
//     re-write another admin's reading of the doctor's order.

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });

const bodySchema = z
  .object({
    itemSku: z.string().trim().min(1).max(64),
    cadenceDays: z.number().int().min(1).max(365),
    validFrom: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    validUntil: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    prescriberName: z
      .string()
      .trim()
      .max(160)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    prescriberNpi: z
      .string()
      .trim()
      .max(20)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    diagnosis: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .strict();

const router: IRouter = Router();

router.post(
  "/patients/:id/prescriptions",
  requireAdmin,
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
    const body = bodyParsed.data;

    // Cross-field check: validUntil >= validFrom when present.
    if (body.validUntil && body.validUntil < body.validFrom) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "validUntil",
            message: "validUntil must be on or after validFrom.",
          },
        ],
      });
      return;
    }

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

    const detailsBlob =
      body.prescriberName ||
      body.prescriberNpi ||
      body.diagnosis ||
      body.notes
        ? {
            prescriberName: body.prescriberName ?? undefined,
            prescriberNpi: body.prescriberNpi ?? undefined,
            diagnosis: body.diagnosis ?? undefined,
            notes: body.notes ?? undefined,
          }
        : null;

    const inserted = await db
      .insert(prescriptions)
      .values({
        patientId,
        itemSku: body.itemSku,
        cadenceDays: body.cadenceDays,
        validFrom: body.validFrom,
        validUntil: body.validUntil ?? null,
        details: detailsBlob,
        status: "active",
      })
      .returning({ id: prescriptions.id });

    const row = inserted[0];
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    const populated = ["itemSku", "cadenceDays", "validFrom"];
    if (body.validUntil) populated.push("validUntil");
    if (body.prescriberName) populated.push("prescriberName");
    if (body.prescriberNpi) populated.push("prescriberNpi");
    if (body.diagnosis) populated.push("diagnosis");
    if (body.notes) populated.push("notes");

    await logAudit({
      action: "patient.prescription.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescriptions",
      targetId: row.id,
      metadata: {
        patient_id: patientId,
        item_sku: body.itemSku,
        cadence_days: body.cadenceDays,
        populated_fields: populated,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.prescription.create audit write failed");
    });

    res.status(201).json({ id: row.id });
  },
);

export default router;
