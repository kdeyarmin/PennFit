// /shop/me/clinical-info — captures the signed-in shopper's CPAP
// device + prescribing-physician details.
//
//   GET  /shop/me/clinical-info — returns { cpapDevice, physicianInfo }
//                                  (each may be null if the customer
//                                  hasn't filled the form out yet).
//   PUT  /shop/me/clinical-info — partial update; pass `null` for an
//                                  object to clear it. Omitting a key
//                                  leaves the existing value alone.
//
// Why a dedicated endpoint (vs. expanding PUT /shop/me):
//   * This is the first PHI surface on `shop_customers`. Keeping
//     the writer isolated lets us audit-log every mutation here
//     without re-shaping the existing PUT /shop/me handler — and
//     makes the PHI write sites easy to grep for ("shop_customer.
//     clinical_info.update" pattern).
//   * The shape is meaningfully larger than the current PUT
//     /shop/me payload (two nested objects each with ~10 fields).
//     A shared validator would balloon and become harder to
//     reason about.
//
// Audit-logging policy:
//   Every successful PUT writes one `shop_customer.clinical_info.update`
//   row to `resupply.audit_log` with a non-PHI metadata envelope
//   (which top-level objects changed + length crumbs only — never
//   the actual physician name or device serial). The audit-log
//   sanitizer (`@workspace/resupply-audit/sanitize`) would catch a
//   careless PHI inclusion, but we don't rely on that — we hand it
//   pre-filtered, structural metadata.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type CpapDeviceInfo,
  type Database,
  type Json,
  type PhysicianInfo,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { logAudit } from "@workspace/resupply-audit";

import { ensureShopCustomerRow } from "../../lib/stripe/customer";
import { requireSignedIn } from "../../middlewares/requireSignedIn";
import { logger } from "../../lib/logger";

type ShopCustomersUpdate = Database["resupply"]["Tables"]["shop_customers"]["Update"];

const router: IRouter = Router();

/**
 * Trim every string in an object, drop empty strings to null, and
 * reject objects where ALL fields are absent (null/empty after
 * normalization). Mirrors the convention the existing PUT /shop/me
 * uses for the shippingAddress: a fully-empty object means "remove
 * the whole record".
 */

const cpapDeviceSchema = z
  .object({
    manufacturer: z.string().trim().min(1).max(80),
    model: z.string().trim().min(1).max(120),
    serialNumber: z.string().trim().max(80).nullable().optional(),
    pressureSetting: z.string().trim().max(60).nullable().optional(),
    humidifierSetting: z.string().trim().max(40).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const physicianInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    practice: z.string().trim().max(160).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    fax: z.string().trim().max(40).nullable().optional(),
    email: z
      .string()
      .trim()
      .max(160)
      .email("Enter a valid email or leave blank")
      .nullable()
      .optional()
      // Allow "" → null because most form serializers send empty
      // strings rather than omit the key, and the email validator
      // would reject "".
      .or(z.literal("").transform(() => null)),
    addressLine1: z.string().trim().max(120).nullable().optional(),
    addressLine2: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().max(80).nullable().optional(),
    state: z
      .string()
      .trim()
      .length(2, "Two-letter state code")
      .toUpperCase()
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    postalCode: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, "5 or 9 digit ZIP")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
    npi: z
      .string()
      .trim()
      .regex(/^\d{10}$/, "NPI is 10 digits")
      .nullable()
      .optional()
      .or(z.literal("").transform(() => null)),
  })
  .strict();

const updateBody = z
  .object({
    /**
     * `undefined` (key absent) → leave the column alone.
     * `null` → clear the column.
     * `object` → replace.
     */
    cpapDevice: cpapDeviceSchema.nullable().optional(),
    physicianInfo: physicianInfoSchema.nullable().optional(),
  })
  .strict();

router.get("/shop/me/clinical-info", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId!;
  await ensureShopCustomerRow({ customerId, email: null });
  const supabase = getSupabaseServiceRoleClient();
  const { data: row } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("cpap_device_json, physician_info_json, facial_measurements_json")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  res.json({
    cpapDevice: row?.cpap_device_json ?? null,
    physicianInfo: row?.physician_info_json ?? null,
    facialMeasurements: row?.facial_measurements_json ?? null,
  });
});

router.put("/shop/me/clinical-info", requireSignedIn, async (req, res) => {
  const parsed = updateBody.safeParse(req.body);
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
  const customerId = req.userCustomerId!;
  await ensureShopCustomerRow({ customerId, email: null });

  const supabase = getSupabaseServiceRoleClient();
  const updates: ShopCustomersUpdate = {
    updated_at: new Date().toISOString(),
  };

  // Track which top-level objects actually changed for the audit
  // metadata. We compute this BEFORE writing so a no-op PUT (the
  // shopper hits Save without changing anything) doesn't waste an
  // audit row.
  const changed: string[] = [];
  let cpapDeviceValue: CpapDeviceInfo | null = null;
  let physicianInfoValue: PhysicianInfo | null = null;

  if (parsed.data.cpapDevice !== undefined) {
    // Normalize empty optional strings → null so the round-trip
    // shape is consistent regardless of how the form serialized.
    cpapDeviceValue =
      parsed.data.cpapDevice === null
        ? null
        : {
            manufacturer: parsed.data.cpapDevice.manufacturer,
            model: parsed.data.cpapDevice.model,
            serialNumber: parsed.data.cpapDevice.serialNumber || null,
            pressureSetting: parsed.data.cpapDevice.pressureSetting || null,
            humidifierSetting: parsed.data.cpapDevice.humidifierSetting || null,
            notes: parsed.data.cpapDevice.notes || null,
          };
    updates.cpap_device_json = cpapDeviceValue as unknown as Json;
    changed.push("cpapDevice");
  }

  if (parsed.data.physicianInfo !== undefined) {
    physicianInfoValue =
      parsed.data.physicianInfo === null
        ? null
        : {
            name: parsed.data.physicianInfo.name,
            practice: parsed.data.physicianInfo.practice || null,
            phone: parsed.data.physicianInfo.phone || null,
            fax: parsed.data.physicianInfo.fax || null,
            email: parsed.data.physicianInfo.email || null,
            addressLine1: parsed.data.physicianInfo.addressLine1 || null,
            addressLine2: parsed.data.physicianInfo.addressLine2 || null,
            city: parsed.data.physicianInfo.city || null,
            state: parsed.data.physicianInfo.state || null,
            postalCode: parsed.data.physicianInfo.postalCode || null,
            npi: parsed.data.physicianInfo.npi || null,
          };
    updates.physician_info_json = physicianInfoValue as unknown as Json;
    changed.push("physicianInfo");
  }

  if (changed.length === 0) {
    // No-op PUT — return the current values without touching the
    // row or writing an audit line.
    const { data: row } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("cpap_device_json, physician_info_json, facial_measurements_json")
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    res.json({
      cpapDevice: row?.cpap_device_json ?? null,
      physicianInfo: row?.physician_info_json ?? null,
      facialMeasurements: row?.facial_measurements_json ?? null,
    });
    return;
  }

  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update(updates)
    .eq("customer_id", customerId)
    .select("cpap_device_json, physician_info_json, facial_measurements_json")
    .maybeSingle();

  if (error || !row) {
    res.status(500).json({ error: "update_failed" });
    return;
  }

  // Audit. The customer is the actor here, not an admin — but the
  // existing logAudit signature uses `adminEmail` / `adminUserId`
  // for the actor envelope. We pass null/null for those (consistent
  // with the patient-self-service self-update pattern) and pin the
  // actor identity through `targetId = customerId` + the metadata.
  // Metadata is structural ONLY: which top-level fields changed +
  // a count crumb so a reviewer can spot suspiciously bulky pastes
  // without exposing actual values.
  await logAudit({
    action: "shop_customer.clinical_info.update",
    adminEmail: null,
    adminUserId: null,
    targetTable: "shop_customers",
    targetId: customerId,
    metadata: {
      changed,
      cpap_device_set: changed.includes("cpapDevice")
        ? cpapDeviceValue !== null
        : false,
      physician_info_set: changed.includes("physicianInfo")
        ? physicianInfoValue !== null
        : false,
      // Length crumb on the optional notes field — operators have
      // asked for this kind of "is someone pasting suspicious
      // content" signal in similar audit rows.
      cpap_notes_length: cpapDeviceValue?.notes?.length ?? 0,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn(
      { err },
      "shop_customer.clinical_info.update audit write failed",
    );
  });

  res.json({
    cpapDevice: row.cpap_device_json ?? null,
    physicianInfo: row.physician_info_json ?? null,
    facialMeasurements: row.facial_measurements_json ?? null,
  });
});

export default router;
