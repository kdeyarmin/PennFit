// /shop/me/equipment — patient self-service equipment registry.
//
//   GET  /shop/me/equipment    — list active assets on file
//   POST /shop/me/equipment    — register a new device (serial,
//                                 manufacturer, model)
//
// Patients sometimes buy CPAPs elsewhere or carry equipment over
// from a previous DME; this endpoint lets them register the device
// without a CSR phone call. The resulting row sits in `active` state
// for CSR review (the SAME state as admin-created rows — there's
// no separate "pending" state on the schema today; surveyors expect
// the asset register to be authoritative so we treat the patient's
// entry as authoritative and let CSRs delete/re-key if they see
// nonsense).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get("/shop/me/equipment", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.json({ assets: [], patientLinked: false });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.json({ assets: [], patientLinked: false });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select(
      "id, device_class, manufacturer, model, serial_number, status, dispensed_at, created_at",
    )
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  res.json({
    patientLinked: true,
    assets: (data ?? []).map((r) => ({
      id: r.id,
      deviceClass: r.device_class,
      manufacturer: r.manufacturer,
      model: r.model,
      // Mask the serial in the patient response to whatever they
      // typed — they own that knowledge anyway, but we don't need
      // a separate sanitizer.
      serialNumber: r.serial_number,
      status: r.status,
      dispensedAt: r.dispensed_at,
      createdAt: r.created_at,
    })),
  });
});

const createBody = z
  .object({
    deviceClass: z.enum([
      "cpap",
      "auto_cpap",
      "bipap",
      "asv",
      "avaps",
      "humidifier",
      "oximeter",
      "other",
    ]),
    // Normalise manufacturer + serial so the
    // (manufacturer, serial_number) unique index in migration 0078
    // collides as intended when a patient self-registers a device
    // an admin has already entered, or vice versa. Without this,
    // "ResMed" / "resmed " / "RESMED " are distinct rows, and a
    // recall scan that exact-matches by manufacturer+serial misses
    // the patient's device.
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
    dispensedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
      .nullable()
      .optional(),
  })
  .strict();

router.post("/shop/me/equipment", requireSignedIn, async (req, res) => {
  const email = req.shopCustomerEmail;
  if (!email) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const patientId = await resolveSinglePatientByEmail(email);
  if (!patientId) {
    res.status(404).json({
      error: "patient_not_linked",
      message:
        "We couldn't link your customer account to a patient record. Please contact support.",
    });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .insert({
      patient_id: patientId,
      device_class: parsed.data.deviceClass,
      manufacturer: parsed.data.manufacturer,
      model: parsed.data.model,
      serial_number: parsed.data.serialNumber,
      dispensed_at: parsed.data.dispensedAt ?? null,
      dispensing_note: "self-registered via patient portal",
    })
    .select("id")
    .single();
  if (error) {
    // The unique-index on (manufacturer, serial_number) gives 23505
    // when the serial is already on file. Surface as a 409 so the UI
    // can render "this device is already registered."
    const code =
      typeof error === "object" && error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "23505") {
      res.status(409).json({
        error: "serial_already_registered",
        message:
          "That serial number is already on file. If it's yours, you're all set.",
      });
      return;
    }
    throw error;
  }
  res.status(201).json({ id: data.id });
});

export default router;
