// /patients/:id/equipment — clinical equipment registry per patient.
//
//   GET    /patients/:id/equipment          — list, newest-first
//   POST   /patients/:id/equipment          — record a dispense
//   PATCH  /patients/:id/equipment/:assetId — status transition + notes
//
// What this route owns
// --------------------
//   * Recording (manufacturer, model, serial) for every device the
//     supplier has dispensed to the patient.
//   * Status transitions (active → returned / recalled / retired,
//     plus the reverses that keep the registry honest).
//
// What this route does NOT own
// ----------------------------
//   * Editing the device-identity fields (manufacturer/model/
//     serial) after creation. Same reasoning as prescription
//     clinical fields: the serial number is what the manufacturer
//     stamped on the device — if a CSR mistyped, the right answer
//     is "mark retired, record correctly as a new row" so the
//     audit trail captures the correction.
//
// Status transitions
// ------------------
//   active   -> returned | recalled | retired
//   returned -> active | retired (admin un-returns a device)
//   recalled -> returned | active (after manufacturer clears)
//   retired  -> active (un-retire on accident)
//
// PHI posture
// -----------
// Patient + serial-number binding is PHI-equivalent. Audit metadata
// records the equipment_assets.id + device class + status only —
// never the serial number in plaintext.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

type EquipmentAssetUpdate =
  Database["resupply"]["Tables"]["equipment_assets"]["Update"];
type EquipmentStatus = NonNullable<
  Database["resupply"]["Tables"]["equipment_assets"]["Row"]["status"]
>;

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const idParam = z.object({ id: z.string().uuid() });
const idAndAssetParam = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
});

const DEVICE_CLASS_VALUES = [
  "cpap",
  "auto_cpap",
  "bipap",
  "asv",
  "avaps",
  "humidifier",
  "oximeter",
  "other",
] as const;

const STATUS_VALUES = ["active", "returned", "recalled", "retired"] as const;

const VALID_TRANSITIONS: Record<EquipmentStatus, readonly EquipmentStatus[]> = {
  active: ["returned", "recalled", "retired"],
  returned: ["active", "retired"],
  recalled: ["returned", "active"],
  retired: ["active"],
};

const createBody = z
  .object({
    deviceClass: z.enum(DEVICE_CLASS_VALUES),
    // Normalised so admin-entered and patient-self-registered rows
    // collide on the (manufacturer, serial_number) unique index
    // and recall scans match across both entry surfaces.
    manufacturer: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((s) => s.toUpperCase()),
    model: z.string().trim().min(1).max(120),
    serialNumber: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .transform((s) => s.toUpperCase().replace(/\s+/g, "")),
    pressureSetting: z
      .string()
      .trim()
      .max(80)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
    humidifierSetting: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
    prescriptionId: z.string().uuid().nullable().optional(),
    dispensedAt: z
      .string()
      .regex(ISO_DATE, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
    dispensingNote: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    pressureSetting: z.string().trim().max(80).nullable().optional(),
    humidifierSetting: z.string().trim().max(32).nullable().optional(),
    dispensingNote: z.string().trim().max(2000).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.get("/patients/:id/equipment", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select(
      "id, patient_id, prescription_id, device_class, manufacturer, model, serial_number, pressure_setting, humidifier_setting, status, dispensed_at, dispensing_note, recall_id, notes, created_at, updated_at",
    )
    .eq("patient_id", parsed.data.id)
    .order("created_at", { ascending: false });
  if (error) throw error;

  res.json({
    equipment: (data ?? []).map((r) => ({
      id: r.id,
      patientId: r.patient_id,
      prescriptionId: r.prescription_id,
      deviceClass: r.device_class,
      manufacturer: r.manufacturer,
      model: r.model,
      serialNumber: r.serial_number,
      pressureSetting: r.pressure_setting,
      humidifierSetting: r.humidifier_setting,
      status: r.status,
      dispensedAt: r.dispensed_at,
      dispensingNote: r.dispensing_note,
      recallId: r.recall_id,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.post("/patients/:id/equipment", requireAdmin, async (req, res) => {
  const idParsed = idParam.safeParse(req.params);
  if (!idParsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const parsed = createBody.safeParse(req.body);
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
  const b = parsed.data;
  const patientId = idParsed.data.id;
  const supabase = getSupabaseServiceRoleClient();

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
    .from("equipment_assets")
    .insert({
      patient_id: patientId,
      prescription_id: b.prescriptionId ?? null,
      device_class: b.deviceClass,
      manufacturer: b.manufacturer,
      model: b.model,
      serial_number: b.serialNumber,
      pressure_setting: b.pressureSetting ?? null,
      humidifier_setting: b.humidifierSetting ?? null,
      dispensed_at: b.dispensedAt ?? null,
      dispensing_note: b.dispensingNote ?? null,
      notes: b.notes ?? null,
      status: "active",
    })
    .select("id")
    .single();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      // Unique violation on (manufacturer, serial_number) — same
      // device is already on file. Only surface cross-patient
      // information when the existing row belongs to THIS patient;
      // otherwise return a generic 409 so an admin can't probe
      // arbitrary serials to enumerate equipment registered to
      // other patients (or harvest their equipment_assets.id).
      const { data: existing } = await supabase
        .schema("resupply")
        .from("equipment_assets")
        .select("id, patient_id")
        .eq("manufacturer", b.manufacturer)
        .eq("serial_number", b.serialNumber)
        .limit(1)
        .maybeSingle();
      const sameOwner = existing && existing.patient_id === patientId;
      res.status(409).json({
        error: "serial_already_registered",
        message: sameOwner
          ? "This serial number is already on this patient's record."
          : "This serial number is already registered. If you believe this is an error, contact support to verify ownership.",
        // Only return existingId for same-patient conflicts; an
        // attacker enumerating serials must not learn other
        // patients' equipment row ids.
        existingId: sameOwner ? (existing?.id ?? null) : null,
      });
      return;
    }
    throw error;
  }

  await logAudit({
    action: "patient.equipment.create",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "equipment_assets",
    targetId: row.id,
    metadata: {
      patient_id: patientId,
      device_class: b.deviceClass,
      manufacturer: b.manufacturer,
      // Serial intentionally withheld from audit metadata — recall-
      // workflow audit happens at the recall-scan endpoint, not on
      // device creation, and the bare serial is PHI-adjacent.
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "patient.equipment.create audit write failed");
  });

  res.status(201).json({ id: row.id });
});

router.patch(
  "/patients/:id/equipment/:assetId",
  requireAdmin,
  async (req, res) => {
    const idParsed = idAndAssetParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = patchBody.safeParse(req.body);
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    if (fields.status !== undefined) {
      const { data: existing } = await supabase
        .schema("resupply")
        .from("equipment_assets")
        .select("status")
        .eq("id", idParsed.data.assetId)
        .eq("patient_id", idParsed.data.id)
        .limit(1)
        .maybeSingle();
      if (!existing) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const fromStatus = existing.status as EquipmentStatus;
      const toStatus = fields.status;
      if (fromStatus !== toStatus) {
        if (!VALID_TRANSITIONS[fromStatus].includes(toStatus)) {
          res.status(400).json({
            error: "invalid_transition",
            message: `Cannot transition equipment from "${fromStatus}" to "${toStatus}".`,
          });
          return;
        }
      }
    }

    const updates: EquipmentAssetUpdate = {};
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.pressureSetting !== undefined)
      updates.pressure_setting = fields.pressureSetting;
    if (fields.humidifierSetting !== undefined)
      updates.humidifier_setting = fields.humidifierSetting;
    if (fields.dispensingNote !== undefined)
      updates.dispensing_note = fields.dispensingNote;
    if (fields.notes !== undefined) updates.notes = fields.notes;

    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("equipment_assets")
      .update(updates)
      .eq("id", idParsed.data.assetId)
      .eq("patient_id", idParsed.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    await logAudit({
      action: "patient.equipment.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "equipment_assets",
      targetId: idParsed.data.assetId,
      metadata: {
        patient_id: idParsed.data.id,
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.equipment.update audit write failed");
    });

    res.status(200).json({ id: idParsed.data.assetId, changed: true });
  },
);

export default router;
