// /admin/compliance/business-associate-agreements — HIPAA
// §164.504(e) BAA inventory.
//
//   GET    /admin/compliance/business-associate-agreements
//          — list with expiry buckets
//   POST   /admin/compliance/business-associate-agreements
//          — record a new BAA
//   PATCH  /admin/compliance/business-associate-agreements/:id
//          — narrow updates (status, attestation, document key, notes)
//
// vendor_slug is immutable post-create. To replace a BAA mark old as
// 'terminated' and add a fresh row.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  BAA_STATUS_VALUES,
  BAA_VENDOR_KIND_VALUES,
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

type BaaUpdate =
  Database["resupply"]["Tables"]["business_associate_agreements"]["Update"];

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9_-]+$/;

const createBody = z
  .object({
    vendorSlug: z.string().trim().min(1).max(64).regex(SLUG_RE),
    vendorLegalName: z.string().trim().min(1).max(200),
    vendorKind: z.enum(BAA_VENDOR_KIND_VALUES),
    scope: z
      .object({
        categories: z.array(z.string().max(60)).max(20).optional(),
        transport: z.array(z.string().max(60)).max(20).optional(),
      })
      .strict()
      .optional(),
    agreementSignedOn: z.string().regex(ISO_DATE).nullable().optional(),
    agreementExpiresOn: z.string().regex(ISO_DATE).nullable().optional(),
    agreementDocumentObjectKey: z.string().trim().max(400).nullable().optional(),
    lastSafeguardAttestationOn: z
      .string()
      .regex(ISO_DATE)
      .nullable()
      .optional(),
    complianceCertifications: z.array(z.string().trim().max(60)).max(20).optional(),
    vendorContactEmail: z.string().trim().email().max(180).nullable().optional(),
    vendorContactPhoneE164: z
      .string()
      .trim()
      .regex(/^\+\d{8,15}$/)
      .nullable()
      .optional(),
    internalOwnerEmail: z.string().trim().email().max(180).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const patchBody = z
  .object({
    status: z.enum(BAA_STATUS_VALUES).optional(),
    agreementExpiresOn: z.string().regex(ISO_DATE).nullable().optional(),
    agreementDocumentObjectKey: z.string().trim().max(400).nullable().optional(),
    lastSafeguardAttestationOn: z
      .string()
      .regex(ISO_DATE)
      .nullable()
      .optional(),
    complianceCertifications: z.array(z.string().trim().max(60)).max(20).optional(),
    vendorContactEmail: z.string().trim().email().max(180).nullable().optional(),
    vendorContactPhoneE164: z
      .string()
      .trim()
      .regex(/^\+\d{8,15}$/)
      .nullable()
      .optional(),
    internalOwnerEmail: z.string().trim().email().max(180).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const idParam = z.object({ id: z.string().uuid() });

const EXPIRING_SOON_DAYS = 60;

function expiryBucket(
  expiresOn: string | null,
  asOf: string,
): "ok" | "expiring_soon" | "expired" {
  if (!expiresOn) return "ok";
  if (expiresOn < asOf) return "expired";
  const exp = new Date(expiresOn).getTime();
  const today = new Date(asOf).getTime();
  if (exp - today < EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000) {
    return "expiring_soon";
  }
  return "ok";
}

router.get(
  "/admin/compliance/business-associate-agreements",
  requirePermission("compliance.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("business_associate_agreements")
      .select("*")
      .order("status", { ascending: true })
      .order("agreement_expires_on", { ascending: true, nullsFirst: false });
    if (error) throw error;
    const asOf = new Date().toISOString().slice(0, 10);
    res.json({
      asOf,
      agreements: (data ?? []).map((row) => ({
        ...row,
        expiry_bucket: expiryBucket(row.agreement_expires_on, asOf),
      })),
    });
  },
);

router.post(
  "/admin/compliance/business-associate-agreements",
  // BAA insertion is a procurement / compliance-officer action; gate
  // tighter than general compliance.read.
  requirePermission("compliance.resolve"),
  async (req, res) => {
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("business_associate_agreements")
      .insert({
        vendor_slug: b.vendorSlug,
        vendor_legal_name: b.vendorLegalName,
        vendor_kind: b.vendorKind,
        scope_json: b.scope ?? {},
        agreement_signed_on: b.agreementSignedOn ?? null,
        agreement_expires_on: b.agreementExpiresOn ?? null,
        agreement_document_object_key: b.agreementDocumentObjectKey ?? null,
        last_safeguard_attestation_on: b.lastSafeguardAttestationOn ?? null,
        compliance_certifications: b.complianceCertifications ?? [],
        vendor_contact_email: b.vendorContactEmail ?? null,
        vendor_contact_phone_e164: b.vendorContactPhoneE164 ?? null,
        internal_owner_email: b.internalOwnerEmail ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "duplicate_vendor_slug" });
        return;
      }
      throw error;
    }
    await logAudit({
      action: "compliance.baa.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "business_associate_agreements",
      targetId: row.id,
      metadata: {
        vendor_slug: b.vendorSlug,
        vendor_kind: b.vendorKind,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.baa.create audit failed");
    });
    res.status(201).json({ id: row.id });
  },
);

router.patch(
  "/admin/compliance/business-associate-agreements/:id",
  requirePermission("compliance.resolve"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
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
    const updates: BaaUpdate = { updated_at: new Date().toISOString() };
    if (fields.status !== undefined) updates.status = fields.status;
    if (fields.agreementExpiresOn !== undefined)
      updates.agreement_expires_on = fields.agreementExpiresOn;
    if (fields.agreementDocumentObjectKey !== undefined)
      updates.agreement_document_object_key =
        fields.agreementDocumentObjectKey;
    if (fields.lastSafeguardAttestationOn !== undefined)
      updates.last_safeguard_attestation_on =
        fields.lastSafeguardAttestationOn;
    if (fields.complianceCertifications !== undefined)
      updates.compliance_certifications = fields.complianceCertifications;
    if (fields.vendorContactEmail !== undefined)
      updates.vendor_contact_email = fields.vendorContactEmail;
    if (fields.vendorContactPhoneE164 !== undefined)
      updates.vendor_contact_phone_e164 = fields.vendorContactPhoneE164;
    if (fields.internalOwnerEmail !== undefined)
      updates.internal_owner_email = fields.internalOwnerEmail;
    if (fields.notes !== undefined) updates.notes = fields.notes;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("business_associate_agreements")
      .update(updates)
      .eq("id", params.data.id)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await logAudit({
      action: "compliance.baa.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "business_associate_agreements",
      targetId: params.data.id,
      metadata: { updated_fields: Object.keys(fields) },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.baa.update audit failed");
    });
    res.status(200).json({ id: params.data.id, changed: true });
  },
);

// Hard delete restricted to super_admin (requireAdminOnly).  Soft-
// disable is preferred — set status='terminated' instead.
router.delete(
  "/admin/compliance/business-associate-agreements/:id",
  requireAdminOnly,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("business_associate_agreements")
      .delete()
      .eq("id", params.data.id);
    if (error) throw error;
    await logAudit({
      action: "compliance.baa.delete",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "business_associate_agreements",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "compliance.baa.delete audit failed");
    });
    res.status(204).end();
  },
);

export default router;
