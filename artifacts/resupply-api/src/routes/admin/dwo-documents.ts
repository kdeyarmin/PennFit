// /admin/dwo-documents — DWO / CMN renewal tracking.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  renderDwoPdf,
  validateDwoInput,
  type DwoPdfInput,
} from "../../lib/billing/dwo-pdf";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type Row = Database["resupply"]["Tables"]["dwo_documents"]["Row"];

const FAMILY_VALUES = [
  "pap",
  "rad",
  "oxygen",
  "hospital_bed",
  "wheelchair",
  "other",
] as const satisfies readonly Row["hcpcs_family"][];
const FORM_VALUES = [
  "dwo",
  "cmn_484",
  "cmn_843",
  "swo",
] as const satisfies readonly Row["form_type"][];

const createBody = z
  .object({
    patientId: z.string().uuid(),
    hcpcsFamily: z.enum(FAMILY_VALUES),
    formType: z.enum(FORM_VALUES),
    signingProviderId: z.string().uuid().nullable().optional(),
    signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    documentObjectKey: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((b) => b.expiresOn >= b.signedOn, {
    message: "expiresOn must be on or after signedOn",
  });

const idParam = z.object({ id: z.string().uuid() });

router.get(
  "/admin/patients/:patientId/dwo-documents",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = z
      .object({ patientId: z.string().uuid() })
      .safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data } = await supabase
      .schema("resupply")
      .from("dwo_documents")
      .select("*")
      .eq("patient_id", parsed.data.patientId)
      .order("expires_on", { ascending: false });
    res.json({ documents: data ?? [] });
  },
);

router.get(
  "/admin/dwo-documents/expiring",
  requirePermission("patients.read"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const days = Number.parseInt(
      typeof req.query.days === "string" ? req.query.days : "60",
      10,
    );
    const horizon = new Date(
      Date.now() + (Number.isFinite(days) ? days : 60) * 24 * 3600 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .schema("resupply")
      .from("dwo_documents")
      .select("*")
      .gte("expires_on", today)
      .lte("expires_on", horizon)
      .order("expires_on", { ascending: true })
      .limit(200);
    res.json({ documents: data ?? [] });
  },
);

// GET /admin/dwo-documents/:id/pdf — render the tracked DWO/CMN order as
// a signable PDF and stream it to the admin's browser. Read-only +
// idempotent (same row → same document), so GET + patients.read, mirror
// of the SWO route. The dwo_documents row only tracked metadata before;
// this turns it into an actual on-file order document.
router.get(
  "/admin/dwo-documents/:id/pdf",
  requirePermission("patients.read"),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row } = await supabase
      .schema("resupply")
      .from("dwo_documents")
      .select(
        "id, patient_id, hcpcs_family, form_type, signing_provider_id, signed_on, expires_on, notes",
      )
      .eq("id", idParsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [{ data: patient }, providerRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name, legal_last_name, date_of_birth, address")
        .eq("id", row.patient_id)
        .limit(1)
        .maybeSingle(),
      row.signing_provider_id
        ? supabase
            .schema("resupply")
            .from("providers")
            .select("legal_name, npi, practice_name, phone_e164, fax_e164")
            .eq("id", row.signing_provider_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const provider = providerRes.data
      ? {
          legalName: providerRes.data.legal_name,
          npi: providerRes.data.npi,
          practiceName: providerRes.data.practice_name,
          phoneE164: providerRes.data.phone_e164,
          faxE164: providerRes.data.fax_e164,
        }
      : null;

    const input: DwoPdfInput = {
      formType: row.form_type,
      hcpcsFamily: row.hcpcs_family,
      signedOn: row.signed_on,
      expiresOn: row.expires_on,
      notes: row.notes,
      patient: {
        legalFirstName: patient.legal_first_name,
        legalLastName: patient.legal_last_name,
        dateOfBirth: patient.date_of_birth,
        address: (patient.address ?? null) as DwoPdfInput["patient"]["address"],
      },
      provider,
      generatedOn: new Date(),
      supplierName: process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps",
    };

    const errors = validateDwoInput(input);
    if (errors.length > 0) {
      res.status(422).json({ error: "incomplete_inputs", issues: errors });
      return;
    }

    const pdf = await renderDwoPdf(input);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${row.form_type}-${row.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(pdf);

    await logAudit({
      action: "dwo_document.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dwo_documents",
      targetId: row.id,
      metadata: {
        patient_id: row.patient_id,
        form: row.form_type,
        family: row.hcpcs_family,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "dwo_document.generated audit write failed");
    });
  },
);

router.post(
  "/admin/dwo-documents",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dwo_documents.create", preset: "mutation" }),
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
    const { data, error } = await supabase
      .schema("resupply")
      .from("dwo_documents")
      .insert({
        patient_id: b.patientId,
        hcpcs_family: b.hcpcsFamily,
        form_type: b.formType,
        signing_provider_id: b.signingProviderId ?? null,
        signed_on: b.signedOn,
        expires_on: b.expiresOn,
        document_object_key: b.documentObjectKey ?? null,
        notes: b.notes ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logAudit({
      action: "dwo_document.create",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "dwo_documents",
      targetId: data.id,
      metadata: {
        patient_id: b.patientId,
        family: b.hcpcsFamily,
        form: b.formType,
        expires_on: b.expiresOn,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "dwo_document.create audit write failed");
    });
    res.status(201).json({ id: data.id });
  },
);

router.delete(
  "/admin/dwo-documents/:id",
  requirePermission("patients.update"),
  adminRateLimit({ name: "dwo_documents.delete", preset: "destroy" }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    await supabase
      .schema("resupply")
      .from("dwo_documents")
      .delete()
      .eq("id", idParsed.data.id);
    res.json({ ok: true });
  },
);

export default router;
