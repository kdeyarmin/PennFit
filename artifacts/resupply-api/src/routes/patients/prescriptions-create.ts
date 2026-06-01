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

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });

// HCPCS Level II codes are 1 letter + 4 digits, optionally followed
// by hyphen-separated 2-char modifiers (KX, NU, RR, GA, ...). We
// permit up to four modifiers, which covers every Medicare CPAP/RAD
// scenario we have seen. Lowercase input is normalized at insert.
const HCPCS_RE = /^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/;

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
    hcpcsCode: z
      .string()
      .trim()
      .max(12)
      .nullable()
      .optional()
      .transform((v) => (v == null || v === "" ? null : v.toUpperCase()))
      .refine(
        (v) => v == null || HCPCS_RE.test(v),
        "must be a HCPCS code like E0601, optionally with modifiers (e.g. A7030-KX)",
      ),
    // Optional FK to the central providers registry. Either:
    //   * providerId (preferred — admin form picks from the lookup), or
    //   * the legacy prescriberName / prescriberNpi pair (kept for
    //     backward compatibility with older clients and so a CSR can
    //     still record an unverified prescriber without an NPI).
    // Both can be sent together; the server keeps them — provider_id
    // is the authoritative pointer, the jsonb captures the form data.
    providerId: z.string().uuid().nullable().optional(),
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
  adminWriteRateLimiter,
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

    const supabase = getSupabaseServiceRoleClient();

    const { data: patient, error: patientError } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (patientError) throw patientError;
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const detailsBlob: Json | null =
      body.prescriberName || body.prescriberNpi || body.diagnosis || body.notes
        ? ({
            prescriberName: body.prescriberName ?? undefined,
            prescriberNpi: body.prescriberNpi ?? undefined,
            diagnosis: body.diagnosis ?? undefined,
            notes: body.notes ?? undefined,
          } as unknown as Json)
        : null;

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .insert({
        patient_id: patientId,
        provider_id: body.providerId ?? null,
        item_sku: body.itemSku,
        cadence_days: body.cadenceDays,
        valid_from: body.validFrom,
        valid_until: body.validUntil ?? null,
        hcpcs_code: body.hcpcsCode ?? null,
        details: detailsBlob,
        status: "active",
      })
      .select("id")
      .single();
    if (error) throw error;

    const populated = ["itemSku", "cadenceDays", "validFrom"];
    if (body.validUntil) populated.push("validUntil");
    if (body.hcpcsCode) populated.push("hcpcsCode");
    if (body.providerId) populated.push("providerId");
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
