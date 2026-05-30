// /admin/dme-organization — read + edit the singleton organizational
// identity row that the 837P builder, HCFA PDF, and accreditation
// binder all pull from.
//
//   GET   /admin/dme-organization                         — singleton row + contacts
//   PUT   /admin/dme-organization                         — admin-only upsert
//   POST  /admin/dme-organization/contacts                — admin-only add contact
//   PATCH /admin/dme-organization/contacts/:id            — admin-only edit
//   DELETE /admin/dme-organization/contacts/:id           — admin-only delete

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const STATE_RE = /^[A-Z]{2}$/;
const ZIP_RE = /^\d{5}(-?\d{4})?$/;
const NPI_RE = /^\d{10}$/;
const TAX_ID_RE = /^\d{9}$/;
const E164_RE = /^\+[1-9]\d{1,14}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type OrgRow = Database["resupply"]["Tables"]["dme_organization"]["Row"];

const ACCREDITATION_VALUES = [
  "achc",
  "boc",
  "tjc",
  "cap",
  "other",
] as const satisfies readonly NonNullable<OrgRow["accreditation_body"]>[];
const CONTACT_ROLES = [
  "billing_manager",
  "compliance_officer",
  "authorized_signer",
  "medical_director",
  "office_manager",
  "edi_contact",
  "credentialing",
  "patient_advocate",
  "other",
] as const satisfies readonly Database["resupply"]["Tables"]["dme_organization_contacts"]["Row"]["role"][];

const orgBody = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    dbaName: z.string().trim().max(200).nullable().optional(),
    taxId: z.string().trim().regex(TAX_ID_RE, "must be 9 digits"),
    organizationalNpi: z.string().trim().regex(NPI_RE, "must be 10 digits"),
    taxonomyCode: z.string().trim().max(10).default("332B00000X"),
    medicarePtan: z.string().trim().max(20).nullable().optional(),
    physicalAddressLine1: z.string().trim().min(1).max(120),
    physicalAddressLine2: z.string().trim().max(120).nullable().optional(),
    physicalCity: z.string().trim().min(1).max(80),
    physicalState: z.string().trim().regex(STATE_RE, "2-letter state"),
    physicalZip: z.string().trim().regex(ZIP_RE, "5 or 9 digit zip"),
    mailingAddressLine1: z.string().trim().max(120).nullable().optional(),
    mailingAddressLine2: z.string().trim().max(120).nullable().optional(),
    mailingCity: z.string().trim().max(80).nullable().optional(),
    mailingState: z.string().trim().regex(STATE_RE).nullable().optional(),
    mailingZip: z.string().trim().regex(ZIP_RE).nullable().optional(),
    payToAddressLine1: z.string().trim().max(120).nullable().optional(),
    payToAddressLine2: z.string().trim().max(120).nullable().optional(),
    payToCity: z.string().trim().max(80).nullable().optional(),
    payToState: z.string().trim().regex(STATE_RE).nullable().optional(),
    payToZip: z.string().trim().regex(ZIP_RE).nullable().optional(),
    phoneE164: z.string().trim().regex(E164_RE, "E.164 (+1...)"),
    faxE164: z.string().trim().regex(E164_RE).nullable().optional(),
    billingEmail: z.string().trim().email().max(180),
    generalEmail: z.string().trim().email().max(180).nullable().optional(),
    websiteUrl: z.string().trim().url().max(240).nullable().optional(),
    accreditationBody: z.enum(ACCREDITATION_VALUES).nullable().optional(),
    accreditationNumber: z.string().trim().max(60).nullable().optional(),
    accreditationExpiresOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    stateLicenseNumber: z.string().trim().max(60).nullable().optional(),
    stateLicenseState: z.string().trim().regex(STATE_RE).nullable().optional(),
    stateLicenseExpiresOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    liabilityCarrier: z.string().trim().max(160).nullable().optional(),
    liabilityPolicyNumber: z.string().trim().max(60).nullable().optional(),
    liabilityExpiresOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    suretyBondCarrier: z.string().trim().max(160).nullable().optional(),
    suretyBondAmountCents: z.number().int().min(0).nullable().optional(),
    suretyBondExpiresOn: z.string().regex(ISO_DATE_RE).nullable().optional(),
    authorizedSignerName: z.string().trim().max(160).nullable().optional(),
    authorizedSignerTitle: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

const contactBody = z
  .object({
    role: z.enum(CONTACT_ROLES),
    name: z.string().trim().min(1).max(160),
    title: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().email().max(180).nullable().optional(),
    phoneE164: z.string().trim().regex(E164_RE).nullable().optional(),
    isPrimary: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict();
const contactPatch = contactBody.partial();

const idParam = z.object({ id: z.string().uuid() });

function orgRowToApi(r: OrgRow) {
  return {
    id: r.id,
    legalName: r.legal_name,
    dbaName: r.dba_name,
    taxId: r.tax_id,
    organizationalNpi: r.organizational_npi,
    taxonomyCode: r.taxonomy_code,
    medicarePtan: r.medicare_ptan,
    physical: {
      line1: r.physical_address_line1,
      line2: r.physical_address_line2,
      city: r.physical_city,
      state: r.physical_state,
      zip: r.physical_zip,
    },
    mailing: r.mailing_address_line1
      ? {
          line1: r.mailing_address_line1,
          line2: r.mailing_address_line2,
          city: r.mailing_city,
          state: r.mailing_state,
          zip: r.mailing_zip,
        }
      : null,
    payTo: r.pay_to_address_line1
      ? {
          line1: r.pay_to_address_line1,
          line2: r.pay_to_address_line2,
          city: r.pay_to_city,
          state: r.pay_to_state,
          zip: r.pay_to_zip,
        }
      : null,
    phoneE164: r.phone_e164,
    faxE164: r.fax_e164,
    billingEmail: r.billing_email,
    generalEmail: r.general_email,
    websiteUrl: r.website_url,
    accreditation: r.accreditation_body
      ? {
          body: r.accreditation_body,
          number: r.accreditation_number,
          expiresOn: r.accreditation_expires_on,
        }
      : null,
    stateLicense: r.state_license_number
      ? {
          number: r.state_license_number,
          state: r.state_license_state,
          expiresOn: r.state_license_expires_on,
        }
      : null,
    liability: r.liability_carrier
      ? {
          carrier: r.liability_carrier,
          policyNumber: r.liability_policy_number,
          expiresOn: r.liability_expires_on,
        }
      : null,
    suretyBond: r.surety_bond_carrier
      ? {
          carrier: r.surety_bond_carrier,
          amountCents: r.surety_bond_amount_cents,
          expiresOn: r.surety_bond_expires_on,
        }
      : null,
    authorizedSigner: r.authorized_signer_name
      ? {
          name: r.authorized_signer_name,
          title: r.authorized_signer_title,
        }
      : null,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

router.get(
  "/admin/dme-organization",
  requirePermission("admin.tools.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: org } = await supabase
      .schema("resupply")
      .from("dme_organization")
      .select("*")
      .eq("singleton", true)
      .limit(1)
      .maybeSingle();
    if (!org) {
      res.json({ organization: null, contacts: [] });
      return;
    }
    const { data: contacts } = await supabase
      .schema("resupply")
      .from("dme_organization_contacts")
      .select("*")
      .eq("organization_id", org.id)
      .order("is_primary", { ascending: false })
      .order("role", { ascending: true });
    res.json({
      organization: orgRowToApi(org),
      contacts: (contacts ?? []).map((c) => ({
        id: c.id,
        role: c.role,
        name: c.name,
        title: c.title,
        email: c.email,
        phoneE164: c.phone_e164,
        isPrimary: c.is_primary,
        isActive: c.is_active,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
    });
  },
);

router.put(
  "/admin/dme-organization",
  requireAdminOnly,
  adminRateLimit({ name: "dme_organization.upsert", preset: "sensitive" }),
  async (req, res) => {
    const parsed = orgBody.safeParse(req.body);
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
    const payload: Database["resupply"]["Tables"]["dme_organization"]["Insert"] =
      {
        singleton: true,
        legal_name: b.legalName,
        dba_name: b.dbaName ?? null,
        tax_id: b.taxId,
        organizational_npi: b.organizationalNpi,
        taxonomy_code: b.taxonomyCode,
        medicare_ptan: b.medicarePtan ?? null,
        physical_address_line1: b.physicalAddressLine1,
        physical_address_line2: b.physicalAddressLine2 ?? null,
        physical_city: b.physicalCity,
        physical_state: b.physicalState,
        physical_zip: b.physicalZip,
        mailing_address_line1: b.mailingAddressLine1 ?? null,
        mailing_address_line2: b.mailingAddressLine2 ?? null,
        mailing_city: b.mailingCity ?? null,
        mailing_state: b.mailingState ?? null,
        mailing_zip: b.mailingZip ?? null,
        pay_to_address_line1: b.payToAddressLine1 ?? null,
        pay_to_address_line2: b.payToAddressLine2 ?? null,
        pay_to_city: b.payToCity ?? null,
        pay_to_state: b.payToState ?? null,
        pay_to_zip: b.payToZip ?? null,
        phone_e164: b.phoneE164,
        fax_e164: b.faxE164 ?? null,
        billing_email: b.billingEmail,
        general_email: b.generalEmail ?? null,
        website_url: b.websiteUrl ?? null,
        accreditation_body: b.accreditationBody ?? null,
        accreditation_number: b.accreditationNumber ?? null,
        accreditation_expires_on: b.accreditationExpiresOn ?? null,
        state_license_number: b.stateLicenseNumber ?? null,
        state_license_state: b.stateLicenseState ?? null,
        state_license_expires_on: b.stateLicenseExpiresOn ?? null,
        liability_carrier: b.liabilityCarrier ?? null,
        liability_policy_number: b.liabilityPolicyNumber ?? null,
        liability_expires_on: b.liabilityExpiresOn ?? null,
        surety_bond_carrier: b.suretyBondCarrier ?? null,
        surety_bond_amount_cents: b.suretyBondAmountCents ?? null,
        surety_bond_expires_on: b.suretyBondExpiresOn ?? null,
        authorized_signer_name: b.authorizedSignerName ?? null,
        authorized_signer_title: b.authorizedSignerTitle ?? null,
        notes: b.notes ?? null,
        updated_at: new Date().toISOString(),
      };

    const { data: existing } = await supabase
      .schema("resupply")
      .from("dme_organization")
      .select("id")
      .eq("singleton", true)
      .limit(1)
      .maybeSingle();
    let rowId: string;
    if (existing) {
      const { error } = await supabase
        .schema("resupply")
        .from("dme_organization")
        .update(payload)
        .eq("id", existing.id);
      if (error) throw error;
      rowId = existing.id;
    } else {
      const { data: newRow, error } = await supabase
        .schema("resupply")
        .from("dme_organization")
        .insert(payload)
        .select("id")
        .single();
      if (error) throw error;
      rowId = newRow.id;
    }

    await logAudit({
      action: "dme_organization.upsert",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dme_organization",
      targetId: rowId,
      metadata: { legal_name: b.legalName, npi: b.organizationalNpi },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "dme_organization.upsert audit write failed");
    });

    res.json({ id: rowId, created: !existing });
  },
);

router.post(
  "/admin/dme-organization/contacts",
  requireAdminOnly,
  adminRateLimit({
    name: "dme_organization_contacts.create",
    preset: "mutation",
  }),
  async (req, res) => {
    const parsed = contactBody.safeParse(req.body);
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
    const { data: org } = await supabase
      .schema("resupply")
      .from("dme_organization")
      .select("id")
      .eq("singleton", true)
      .limit(1)
      .maybeSingle();
    if (!org) {
      res.status(409).json({
        error: "organization_missing",
        message: "create the dme_organization row first",
      });
      return;
    }
    const { data, error } = await supabase
      .schema("resupply")
      .from("dme_organization_contacts")
      .insert({
        organization_id: org.id,
        role: b.role,
        name: b.name,
        title: b.title ?? null,
        email: b.email ?? null,
        phone_e164: b.phoneE164 ?? null,
        is_primary: b.isPrimary,
        is_active: b.isActive,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "dme_organization.contact_create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dme_organization_contacts",
      targetId: data.id,
      metadata: { role: b.role, name: b.name },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "dme_organization.contact_create audit write failed",
      );
    });
    res.status(201).json({ id: data.id });
  },
);

router.patch(
  "/admin/dme-organization/contacts/:id",
  requireAdminOnly,
  adminRateLimit({
    name: "dme_organization_contacts.update",
    preset: "mutation",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = contactPatch.safeParse(req.body);
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
    const update: Database["resupply"]["Tables"]["dme_organization_contacts"]["Update"] =
      {
        updated_at: new Date().toISOString(),
      };
    if (b.role !== undefined) update.role = b.role;
    if (b.name !== undefined) update.name = b.name;
    if (b.title !== undefined) update.title = b.title;
    if (b.email !== undefined) update.email = b.email;
    if (b.phoneE164 !== undefined) update.phone_e164 = b.phoneE164;
    if (b.isPrimary !== undefined) update.is_primary = b.isPrimary;
    if (b.isActive !== undefined) update.is_active = b.isActive;
    const supabase = getSupabaseServiceRoleClient();
    const { data: updated, error } = await supabase
      .schema("resupply")
      .from("dme_organization_contacts")
      .update(update)
      .eq("id", idParsed.data.id)
      .select("id");
    if (error) throw error;
    if (!updated || updated.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true });
  },
);

router.delete(
  "/admin/dme-organization/contacts/:id",
  requireAdminOnly,
  adminRateLimit({
    name: "dme_organization_contacts.delete",
    preset: "destroy",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("dme_organization_contacts")
      .delete()
      .eq("id", idParsed.data.id);
    if (error) throw error;
    res.json({ ok: true });
  },
);

export default router;
