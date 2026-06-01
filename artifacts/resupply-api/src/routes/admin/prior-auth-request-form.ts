// GET /admin/patients/:id/prior-authorizations/:paId/request-form
//
// Renders the universal DME/PAP Prior-Authorization Request Form as a
// PDF and streams it to the calling admin. Auto-populated from the
// prior_authorizations row + the linked patient / coverage / payer
// profile / ordering provider / most-recent sleep study, this is the
// faxable (or portal-attachable) artifact a CSR sends to the payer's
// `prior_auth_fax_e164` to open an auth — the realistic "quicker
// turnaround" path for the ~50 PA-requiring payers in the catalog that
// have NOT stood up a Da Vinci PAS FHIR endpoint yet.
//
// The renderer + data contract live in lib/billing/pa-request-pdf.ts;
// this route is the data-fetch + orchestration layer (mirrors swo.ts).
//
// Why GET: the form is a deterministic projection of the PA + patient
// record, so it's safe to refresh/reprint. `Cache-Control: no-store`
// keeps the PHI bytes out of the browser disk cache.
//
// PHI posture: the PDF carries PHI; we stream it and never persist or
// log the bytes. One `prior_auth.request_form.generated` audit row per
// call (counts/ids only, no PHI) records the access.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  renderPaRequestPdf,
  type PaRequestInput,
  type PaRequestLine,
  type PaRequestPostalAddress,
} from "../../lib/billing/pa-request-pdf";
import { resolveBillingIdentity } from "../../lib/billing/identity-resolver";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const paramsSchema = z.object({
  id: z.string().uuid(),
  paId: z.string().uuid(),
});

// PAP-relevant HCPCS labels so the item line reads in plain language.
// Falls back to the raw code for anything not listed.
const HCPCS_LABELS: Record<string, string> = {
  E0601: "CPAP device",
  E0470: "Respiratory assist device (BiPAP), without backup",
  E0471: "Respiratory assist device (BiPAP ST), with backup",
  E0561: "Humidifier, non-heated (for PAP)",
  E0562: "Humidifier, heated (for PAP)",
  A7027: "Combination oral/nasal mask",
  A7028: "Oral cushion for combination mask",
  A7029: "Nasal pillows for combination mask",
  A7030: "Full face mask interface",
  A7031: "Full face mask cushion",
  A7032: "Nasal mask cushion",
  A7033: "Nasal pillows",
  A7034: "Nasal mask interface",
  A7035: "Headgear",
  A7036: "Chinstrap",
  A7037: "Tubing",
  A7038: "Disposable filter",
  A7039: "Non-disposable filter",
  A7046: "Water chamber for humidifier",
};

// PAP devices carry a lifetime length-of-need (99 months is the
// long-standing DME convention for capped-rental respiratory items).
const PAP_DEVICE_CODES = new Set(["E0601", "E0470", "E0471"]);

interface JsonAddress {
  line1?: string;
  line2?: string;
  line3?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function toPostalAddress(raw: unknown): PaRequestPostalAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as JsonAddress;
  if (!a.line1 || !a.city || !a.state || !a.zip) return null;
  return {
    line1: a.line1,
    line2: a.line2 ?? null,
    line3: a.line3 ?? null,
    city: a.city,
    state: a.state,
    zip: a.zip,
  };
}

router.get(
  "/admin/patients/:id/prior-authorizations/:paId/request-form",
  // Read-only per-patient projection — every role with patients.read
  // (i.e. every current admin role) can pull it, same as the SWO.
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { id: patientId, paId } = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    // 1. The PA row (scoped to the patient so a guessed paId can't leak
    //    another patient's PA).
    const { data: pa, error: paErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select(
        "id, patient_id, insurance_coverage_id, hcpcs_code, payer_name, auth_number, status, notes",
      )
      .eq("id", paId)
      .eq("patient_id", patientId)
      .limit(1)
      .maybeSingle();
    if (paErr) throw paErr;
    if (!pa) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }

    // 2. Patient + coverage + payer profile + most-recent sleep study,
    //    in parallel. Coverage is optional (a draft PA may predate the
    //    coverage link); the form just leaves those fields blank.
    const [
      { data: patient, error: patErr },
      { data: coverage },
      { data: payerProfile },
      { data: study },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select(
          "id, legal_first_name, legal_last_name, date_of_birth, address, phone_e164",
        )
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      pa.insurance_coverage_id
        ? supabase
            .schema("resupply")
            .from("insurance_coverages")
            .select("id, payer_name, member_id, group_number, plan_name")
            .eq("id", pa.insurance_coverage_id)
            .eq("patient_id", patientId)
            .limit(1).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .schema("resupply")
        .from("payer_profiles")
        .select(
          "display_name, payer_legal_name, prior_auth_fax_e164, prior_auth_phone_e164, prior_auth_submission_method, provider_portal_url, prior_auth_turnaround_business_days, required_claim_modifiers, slug",
        )
        .ilike("display_name", pa.payer_name)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("sleep_studies")
        .select(
          "study_type, study_date, ahi, rdi, diagnosis_icd10, facility_name",
        )
        .eq("patient_id", patientId)
        .order("study_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (patErr) throw patErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // 3. Ordering provider via the most-recent prescription. Best-effort
    //    — prefer a prescription that matches the PA's HCPCS, else the
    //    newest one. A PA can legitimately precede an Rx link, in which
    //    case the provider block prints blank for the clinician to fill.
    const { data: rxMatch } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select("provider_id, hcpcs_code, details")
      .eq("patient_id", patientId)
      .eq("hcpcs_code", pa.hcpcs_code)
      .order("valid_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    const rx =
      rxMatch ??
      (
        await supabase
          .schema("resupply")
          .from("prescriptions")
          .select("provider_id, hcpcs_code, details")
          .eq("patient_id", patientId)
          .order("valid_from", { ascending: false })
          .limit(1)
          .maybeSingle()
      ).data;

    let provider: {
      legal_name: string;
      npi: string;
      phone_e164: string | null;
      fax_e164: string | null;
    } | null = null;
    if (rx?.provider_id) {
      const { data: prov } = await supabase
        .schema("resupply")
        .from("providers")
        .select("legal_name, npi, phone_e164, fax_e164")
        .eq("id", rx.provider_id)
        .limit(1)
        .maybeSingle();
      provider = prov ?? null;
    }

    // 4. Servicing supplier (us).
    const identity = await resolveBillingIdentity({ supabase });
    const supplierName =
      identity.source !== "stub"
        ? identity.billingProvider.organizationName
        : process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";

    // 5. Build the requested item line(s). The PA is a single-HCPCS
    //    record; we render that line and attach the payer's required
    //    DME modifiers so the auth covers the modifiers the claim will
    //    carry.
    const requiredModifiers = (payerProfile?.required_claim_modifiers ??
      []) as string[];
    const requestedLines: PaRequestLine[] = [
      {
        hcpcsCode: pa.hcpcs_code,
        description: HCPCS_LABELS[pa.hcpcs_code] ?? pa.hcpcs_code,
        modifiers: requiredModifiers,
        quantity: 1,
        lengthOfNeedMonths: PAP_DEVICE_CODES.has(pa.hcpcs_code) ? 99 : null,
      },
    ];

    // Prescribed pressure is stored loosely on the Rx details jsonb;
    // probe a few common keys and otherwise leave it for the clinician.
    const details = (rx?.details ?? {}) as Record<string, unknown>;
    const prescribedPressure =
      pickString(details, [
        "prescribedPressure",
        "pressure",
        "titrationPressure",
      ]) ?? null;

    const input: PaRequestInput = {
      generatedOn: new Date(),
      payerDisplayName: payerProfile?.display_name ?? pa.payer_name,
      payerPriorAuthFaxE164: payerProfile?.prior_auth_fax_e164 ?? null,
      payerPriorAuthPhoneE164: payerProfile?.prior_auth_phone_e164 ?? null,
      payerSubmissionMethod: payerProfile?.prior_auth_submission_method ?? null,
      payerProviderPortalUrl: payerProfile?.provider_portal_url ?? null,
      payerTurnaroundBusinessDays:
        payerProfile?.prior_auth_turnaround_business_days ?? null,
      supplierName,
      supplierNpi:
        identity.source !== "stub" ? identity.billingProvider.npi : null,
      supplierTaxId:
        identity.source !== "stub" ? identity.billingProvider.taxId : null,
      supplierAddress:
        identity.source !== "stub"
          ? {
              line1: identity.billingProvider.address.line1,
              line2: identity.billingProvider.address.line2 ?? null,
              city: identity.billingProvider.address.city,
              state: identity.billingProvider.address.state,
              zip: identity.billingProvider.address.zip,
            }
          : null,
      supplierPhoneE164: process.env.RESUPPLY_PRACTICE_PHONE?.trim() || null,
      patientLastName: patient.legal_last_name,
      patientFirstName: patient.legal_first_name,
      patientDateOfBirth: patient.date_of_birth,
      patientSex: null,
      patientAddress: toPostalAddress(patient.address),
      patientPhoneE164: patient.phone_e164 ?? null,
      memberId: coverage?.member_id ?? "",
      groupNumber: coverage?.group_number ?? null,
      planName: coverage?.plan_name ?? null,
      existingAuthNumber: pa.auth_number ?? null,
      orderingProviderName: provider?.legal_name ?? null,
      orderingProviderNpi: provider?.npi ?? null,
      orderingProviderPhoneE164: provider?.phone_e164 ?? null,
      orderingProviderFaxE164: provider?.fax_e164 ?? null,
      requestedLines,
      diagnosisIcd10: study?.diagnosis_icd10 ?? null,
      faceToFaceDate: null,
      sleepStudy: study
        ? {
            type: study.study_type,
            date: study.study_date,
            ahi: study.ahi,
            rdi: study.rdi,
            facilityName: study.facility_name,
          }
        : null,
      prescribedPressure,
      clinicalNotes: pa.notes ?? null,
    };

    const pdf = await renderPaRequestPdf(input);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="pa-request-${patientId.slice(0, 8)}-${paId.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);

    await logAudit({
      action: "prior_auth.request_form.generated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: pa.id,
      metadata: {
        patient_id: patientId,
        hcpcs_code: pa.hcpcs_code,
        payer_slug: payerProfile?.slug ?? null,
        has_sleep_study: Boolean(study),
        has_provider: Boolean(provider),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "prior_auth.request_form.generated audit write failed",
      );
    });
  },
);

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export default router;
