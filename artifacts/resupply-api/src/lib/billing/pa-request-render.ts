// Shared builder for the universal DME/PAP Prior-Authorization Request
// Form PDF. Extracted from routes/admin/prior-auth-request-form.ts so it
// can be rendered from two places with identical output:
//
//   * GET .../prior-authorizations/:paId/request-form — the CSR download
//   * GET /fax/document/:token (kind=pa_request) — render-on-demand when
//     Telnyx fetches the mediaUrl to transmit the fax
//
// The PDF is a deterministic projection of the PA + patient record, so a
// stable signed token can re-render it on demand without persisting bytes.
//
// PHI posture: builds PHI bytes but never logs them. The caller owns the
// (PHI-free, counts/ids only) audit row.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  renderPaRequestPdf,
  type PaRequestInput,
  type PaRequestLine,
  type PaRequestPostalAddress,
} from "./pa-request-pdf";
import { resolveBillingIdentity } from "./identity-resolver";
import { getDocumentSupplierName } from "../company-info";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

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
  postalCode?: string;
  postal_code?: string;
}

function toPostalAddress(raw: unknown): PaRequestPostalAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as JsonAddress;
  const zip = a.zip ?? a.postalCode ?? a.postal_code;
  if (!a.line1 || !a.city || !a.state || !zip) return null;
  return {
    line1: a.line1,
    line2: a.line2 ?? null,
    line3: a.line3 ?? null,
    city: a.city,
    state: a.state,
    zip,
  };
}

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

/** The render result + the PHI-free metadata the caller's audit row needs. */
export interface PaRequestRenderResult {
  pdf: Buffer;
  /** The payer's published prior-auth fax number (E.164) when known —
   *  the default destination for a fax dispatch. */
  payerPriorAuthFaxE164: string | null;
  payerSlug: string | null;
  hcpcsCode: string;
  hasSleepStudy: boolean;
  hasProvider: boolean;
}

/**
 * Assemble + render the PA request form PDF for one prior_authorizations
 * row, scoped to its patient. Returns null when the PA or patient isn't
 * found (a guessed paId can't leak another patient's PA). Pure read — no
 * writes, no logging of PHI.
 */
export async function buildPaRequestPdf(
  supabase: SupabaseClient,
  patientId: string,
  paId: string,
): Promise<PaRequestRenderResult | null> {
  // 1. The PA row (scoped to the patient).
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
  if (!pa) return null;

  // 2. Patient + coverage + payer profile + most-recent sleep study.
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
          .limit(1)
          .maybeSingle()
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
  if (!patient) return null;

  // 3. Ordering provider via the most-recent prescription (prefer one
  //    matching the PA's HCPCS, else the newest).
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
      : await getDocumentSupplierName();

  // 5. Requested item line(s) + merged modifiers.
  const requiredModifiers = (payerProfile?.required_claim_modifiers ??
    []) as string[];
  const rawHcpcs = String(pa.hcpcs_code ?? "");
  const [baseHcpcsRaw, ...hcpcsSuffix] = rawHcpcs.split("-");
  const baseHcpcs = (baseHcpcsRaw ?? rawHcpcs).trim().toUpperCase();
  const mergedModifiers = [
    ...new Set(
      [
        ...hcpcsSuffix.map((m: string) => m.trim().toUpperCase()),
        ...requiredModifiers,
      ].filter(Boolean),
    ),
  ];
  const requestedLines: PaRequestLine[] = [
    {
      hcpcsCode: baseHcpcs,
      description: HCPCS_LABELS[baseHcpcs] ?? rawHcpcs,
      modifiers: mergedModifiers,
      quantity: 1,
      lengthOfNeedMonths: PAP_DEVICE_CODES.has(baseHcpcs) ? 99 : null,
    },
  ];

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

  return {
    pdf,
    payerPriorAuthFaxE164: payerProfile?.prior_auth_fax_e164 ?? null,
    payerSlug: payerProfile?.slug ?? null,
    hcpcsCode: String(pa.hcpcs_code ?? ""),
    hasSleepStudy: Boolean(study),
    hasProvider: Boolean(provider),
  };
}
