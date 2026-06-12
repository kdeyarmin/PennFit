// GET /admin/patients/:id/prescriptions/:rxId/swo
//
// Renders the CMS-standardized Standard Written Order as a PDF and
// streams it to the calling admin's browser. The renderer + data
// contract live in lib/swo-pdf.ts; this route is the data-fetch +
// orchestration layer.
//
// Why GET (not POST)
// ------------------
// SWO generation is idempotent — the same prescription always
// produces the same SWO. Allowing a GET means the CSR can refresh
// the printed copy at any time, and the browser caches the PDF
// per-tab (`Cache-Control: no-store` keeps the bytes out of the
// disk cache; the PHI doesn't linger).
//
// Audit
// -----
// One `patient.swo.generated` audit row per call so the access
// trail surfaces every time someone produces an SWO. Metadata
// includes the patient + Rx id; never the PDF bytes.

import { Router, type IRouter } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { getDocumentSupplierName } from "../../lib/company-info";
import { logger } from "../../lib/logger";
import {
  renderSwo,
  validateSwoInputs,
  type SwoInputs,
  type SwoPatient,
  type SwoPrescription,
  type SwoProvider,
} from "../../lib/swo-pdf";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const paramsSchema = z.object({
  id: z.string().uuid(),
  rxId: z.string().uuid(),
});

router.get(
  "/admin/patients/:id/prescriptions/:rxId/swo",
  // CMS-standardized SWO PDF render. Read-only and per-patient —
  // every role with `patients.read` (i.e. every current role) can
  // pull it.
  requirePermission("patients.read"),
  async (req, res) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { id: patientId, rxId } = params.data;

    const supabase = getSupabaseServiceRoleClient();

    // Fetch patient + Rx in parallel; provider + most-recent
    // sleep-study come on a second pass once we have the Rx's
    // provider_id.
    const [patientRes, rxRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name, date_of_birth, address")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("prescriptions")
        .select(
          "id, patient_id, provider_id, item_sku, hcpcs_code, cadence_days, valid_from, valid_until, details",
        )
        .eq("id", rxId)
        .limit(1)
        .maybeSingle(),
    ]);

    if (patientRes.error) throw patientRes.error;
    if (rxRes.error) throw rxRes.error;

    const patientRow = patientRes.data;
    const rxRow = rxRes.data;

    if (!patientRow || !rxRow || rxRow.patient_id !== patientId) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Resolve the provider via the new FK. If the Rx hasn't been
    // linked yet (jsonb-only prescriber, pre-backfill), surface a
    // clear 422 explaining what's missing.
    if (!rxRow.provider_id) {
      res.status(422).json({
        error: "missing_provider_link",
        message:
          "This prescription has no linked provider yet. Link the prescriber to a provider in the registry before generating an SWO.",
      });
      return;
    }

    const [providerRes, latestStudyRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("providers")
        .select(
          "id, npi, legal_name, practice_name, practice_address, phone_e164, fax_e164",
        )
        .eq("id", rxRow.provider_id)
        .limit(1)
        .maybeSingle(),
      // Pull the most recent sleep-study ICD-10 to populate the
      // "Diagnosis (ICD-10)" line. Optional — SWO doesn't strictly
      // require it on the form per the 2020 rule, but Medicare
      // auditors expect it in the record.
      supabase
        .schema("resupply")
        .from("sleep_studies")
        .select("diagnosis_icd10")
        .eq("patient_id", patientId)
        .order("study_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (providerRes.error) throw providerRes.error;
    if (latestStudyRes.error) throw latestStudyRes.error;

    if (!providerRes.data) {
      res.status(422).json({
        error: "provider_missing",
        message:
          "The linked provider row was not found. Re-link the prescription to an existing provider.",
      });
      return;
    }

    const details = (rxRow.details ?? {}) as {
      diagnosis?: string;
    };

    const patient: SwoPatient = {
      legalFirstName: patientRow.legal_first_name,
      legalLastName: patientRow.legal_last_name,
      dateOfBirth: patientRow.date_of_birth,
      address: (patientRow.address ?? null) as SwoPatient["address"],
    };
    const prescription: SwoPrescription = {
      itemSku: rxRow.item_sku,
      hcpcsCode: rxRow.hcpcs_code,
      cadenceDays: rxRow.cadence_days,
      validFrom: rxRow.valid_from,
      validUntil: rxRow.valid_until,
      diagnosis: details.diagnosis ?? null,
      diagnosisIcd10: latestStudyRes.data?.diagnosis_icd10 ?? null,
    };
    const provider: SwoProvider = {
      legalName: providerRes.data.legal_name,
      npi: providerRes.data.npi,
      practiceName: providerRes.data.practice_name,
      practiceAddress: (providerRes.data.practice_address ??
        null) as SwoProvider["practiceAddress"],
      phoneE164: providerRes.data.phone_e164,
      faxE164: providerRes.data.fax_e164,
    };

    const supplierName = await getDocumentSupplierName();
    const inputs: SwoInputs = {
      patient,
      prescription,
      provider,
      generatedOn: new Date(),
      supplierName,
    };

    const errors = validateSwoInputs(inputs);
    if (errors.length > 0) {
      res.status(422).json({
        error: "incomplete_inputs",
        issues: errors,
      });
      return;
    }

    // ── Stream the PDF ────────────────────────────────────────────────
    const doc = new PDFDocument({ margin: 72, size: "LETTER" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="swo-${patientId.slice(0, 8)}-${rxId.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    doc.pipe(res);
    renderSwo(doc, inputs);
    doc.end();

    // Audit AFTER renderSwo to capture the successful generation;
    // a render that throws would leave no audit row (and a 500
    // response), which is correct — we don't claim to have
    // generated an SWO that the admin never saw.
    await logAudit({
      action: "patient.swo.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescriptions",
      targetId: rxId,
      metadata: {
        patient_id: patientId,
        hcpcs_code: prescription.hcpcsCode,
        provider_npi: provider.npi,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.swo.generated audit write failed");
    });
  },
);

export default router;
