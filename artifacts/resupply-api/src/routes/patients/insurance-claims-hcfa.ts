// /admin/patients/:id/insurance-claims/:claimId/hcfa-1500.pdf
//
// Renders the CMS-1500 (HCFA-1500) paper claim form for a single
// claim. Streams the PDF back to the requesting admin; does NOT
// persist the binary.
//
// Use case: a payer in the catalog is `paper_only` (no Office Ally
// payer id), or a CSR needs to send a printed claim for a one-off
// (override, appeal addendum, secondary payer that doesn't accept
// crossover EDI). For paper_only payers the submit-office-ally
// endpoint rejects at 409; this is the supported alternative.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  renderHcfa1500Pdf,
  type Hcfa1500Input,
} from "../../lib/billing/hcfa-1500-pdf";
import {
  parsePostalAddress,
  type PostalAddress as PayerPostalAddress,
} from "../../lib/billing/payer-address";
import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const params = z.object({
  id: z.string().uuid(),
  claimId: z.string().uuid(),
});

router.get(
  "/patients/:id/insurance-claims/:claimId/hcfa-1500.pdf",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = params.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: claim, error } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, date_of_service, total_billed_cents, insurance_coverage_id, payer_profile_id, referring_provider_id, denial_reason",
      )
      .eq("id", parsed.data.claimId)
      .eq("patient_id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!claim) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const [
      { data: patient },
      { data: coverage },
      { data: lines },
      { data: payerProfile },
      { data: referringProvider },
      { data: sleep },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name, legal_last_name, date_of_birth, address")
        .eq("id", claim.patient_id)
        .limit(1)
        .maybeSingle(),
      claim.insurance_coverage_id
        ? supabase
            .schema("resupply")
            .from("insurance_coverages")
            .select("member_id, group_number, policyholder_name, policyholder_relationship")
            .eq("id", claim.insurance_coverage_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .schema("resupply")
        .from("insurance_claim_line_items")
        .select("hcpcs_code, modifier, billed_cents, quantity")
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: true }),
      claim.payer_profile_id
        ? supabase
            .schema("resupply")
            .from("payer_profiles")
            .select("payer_legal_name, claims_mailing_address")
            .eq("id", claim.payer_profile_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      claim.referring_provider_id
        ? supabase
            .schema("resupply")
            .from("providers")
            .select("legal_name, npi")
            .eq("id", claim.referring_provider_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Phase 14 — pull the patient's most recent sleep-study diagnosis
      // so the HCFA carries the real ICD-10 instead of the previously-
      // hardcoded G47.33 fallback.
      supabase
        .schema("resupply")
        .from("sleep_studies")
        .select("diagnosis_icd10")
        .eq("patient_id", claim.patient_id)
        .not("diagnosis_icd10", "is", null)
        .order("study_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!coverage) {
      res.status(400).json({ error: "missing_coverage" });
      return;
    }

    const patientAddress = pickAddress(patient.address);
    if (!patientAddress) {
      res.status(400).json({
        error: "missing_patient_address",
        message: "patient must have a structured address before generating HCFA",
      });
      return;
    }

    // Read billing-provider identity from the OA config envs (the
    // same source the EDI builder uses; mirrors the "one source of
    // truth for our identity" contract).
    const billingProviderName = process.env.OFFICE_ALLY_BILLING_ORG_NAME ?? "DME SUPPLIER";
    const billingProviderNpi = process.env.OFFICE_ALLY_BILLING_NPI ?? "0000000000";
    const taxId = process.env.OFFICE_ALLY_BILLING_TAX_ID ?? "000000000";
    const billingProviderAddress = {
      line1: process.env.OFFICE_ALLY_BILLING_ADDRESS_LINE1 ?? "—",
      city: process.env.OFFICE_ALLY_BILLING_CITY ?? "—",
      state: process.env.OFFICE_ALLY_BILLING_STATE ?? "PA",
      zip: process.env.OFFICE_ALLY_BILLING_ZIP ?? "00000",
    };

    const payerMailingParsed: PayerPostalAddress | null = parsePostalAddress(
      payerProfile?.claims_mailing_address,
    );
    // Coerce to the HCFA-renderer's PostalAddress shape (line2 is
    // `string | undefined` there, not `string | null`).
    const payerMailingAddress: Hcfa1500Input["payerMailingAddress"] =
      payerMailingParsed
        ? {
            line1: payerMailingParsed.line1,
            line2: payerMailingParsed.line2 ?? undefined,
            city: payerMailingParsed.city,
            state: payerMailingParsed.state,
            zip: payerMailingParsed.zip,
          }
        : null;
    const diagnosisCodes = sleep?.diagnosis_icd10
      ? [sleep.diagnosis_icd10]
      : ["G47.33"];

    const input: Hcfa1500Input = {
      insuranceType: "group_health",
      insuredIdNumber: coverage.member_id,
      patientLastName: patient.legal_last_name,
      patientFirstName: patient.legal_first_name,
      patientMiddleInitial: null,
      patientDateOfBirth: patient.date_of_birth,
      patientSex: "U",
      insuredName:
        coverage.policyholder_name ??
        `${patient.legal_last_name}, ${patient.legal_first_name}`,
      patientAddress,
      relationship: (coverage.policyholder_relationship ?? "self") as Hcfa1500Input["relationship"],
      insuredAddress: patientAddress,
      policyOrGroupNumber: coverage.group_number ?? coverage.member_id,
      payerName: payerProfile?.payer_legal_name ?? claim.payer_name,
      payerMailingAddress,
      referringProviderName: referringProvider?.legal_name ?? null,
      referringProviderNpi: referringProvider?.npi ?? null,
      diagnosisCodes,
      priorAuthNumber: null,
      serviceLines: (lines ?? []).map((l) => ({
        fromDate: claim.date_of_service,
        toDate: claim.date_of_service,
        placeOfService: "12",
        hcpcsCode: l.hcpcs_code,
        modifiers: ((l.modifier ?? "") as string)
          .split(",")
          .map((m: string) => m.trim().toUpperCase())
          .filter((m: string) => m.length === 2),
        diagnosisPointer: "A",
        // Box 24F is the EXTENDED line charge (per-unit billed_cents x
        // units); Box 24G (units) carries the quantity separately.
        chargesCents: l.billed_cents * l.quantity,
        units: l.quantity,
      })),
      taxId,
      totalChargeCents: claim.total_billed_cents,
      signatureOnFile: "SIGNATURE ON FILE",
      billingProviderName,
      billingProviderAddress,
      billingProviderNpi,
      billingProviderPhoneE164:
        process.env.OFFICE_ALLY_CONTACT_PHONE_E164 ?? "",
    };

    const pdf = await renderHcfa1500Pdf(input);

    await logAudit({
      action: "insurance_claim.render_hcfa_pdf",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "insurance_claims",
      targetId: claim.id,
      metadata: {
        patient_id: claim.patient_id,
        bytes: pdf.length,
        line_count: (lines ?? []).length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "insurance_claim.render_hcfa_pdf audit write failed",
      );
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="hcfa-${claim.id.slice(0, 8)}.pdf"`,
    );
    res.status(200).end(pdf);
  },
);

function pickAddress(
  raw: unknown,
): { line1: string; city: string; state: string; zip: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as { line1?: unknown; city?: unknown; state?: unknown; zip?: unknown };
  const line1 = typeof a.line1 === "string" ? a.line1 : "";
  const city = typeof a.city === "string" ? a.city : "";
  const state = typeof a.state === "string" ? a.state : "";
  const zip = typeof a.zip === "string" ? a.zip : "";
  if (!line1 || !city || !state || !zip) return null;
  return { line1, city, state, zip };
}

export default router;
