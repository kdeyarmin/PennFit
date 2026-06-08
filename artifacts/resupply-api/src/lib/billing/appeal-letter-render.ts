// Render an EXISTING appeal letter (claim_appeal_letters row) to a PDF
// buffer (biller #B1). The appeal POST route renders from the request
// body at creation time; this re-renders a stored letter on demand so it
// can be (a) faxed via the signed fax-document URL and (b) re-downloaded.
// It re-derives the same payer/patient/identity context the POST route
// uses so the document is identical.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { renderAppealPdf } from "./appeal-pdf";
import { resolveBillingIdentity } from "./identity-resolver";
import { parsePayerAddressLines } from "./payer-address";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type AppealRenderResult =
  | { ok: true; pdf: Buffer; claimId: string; patientId: string }
  | {
      ok: false;
      reason:
        | "letter_not_found"
        | "claim_not_found"
        | "patient_not_found"
        | "no_dme_organization";
    };

/**
 * Load a claim_appeal_letters row + its claim/patient/payer/identity
 * context and render the appeal-letter PDF. Returns a discriminated
 * result so callers map each miss to the right HTTP status.
 */
export async function renderAppealPdfForLetterId(
  supabase: SupabaseClient,
  letterId: string,
): Promise<AppealRenderResult> {
  const { data: letter } = await supabase
    .schema("resupply")
    .from("claim_appeal_letters")
    .select("id, claim_id, letter_body")
    .eq("id", letterId)
    .limit(1)
    .maybeSingle();
  if (!letter) return { ok: false, reason: "letter_not_found" };

  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, payer_profile_id, claim_number, date_of_service, denial_reason, insurance_coverage_id",
    )
    .eq("id", letter.claim_id)
    .limit(1)
    .maybeSingle();
  if (!claim) return { ok: false, reason: "claim_not_found" };

  const [{ data: patient }, { data: coverage }, { data: payerProfile }] =
    await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name, legal_last_name")
        .eq("id", claim.patient_id)
        .limit(1)
        .maybeSingle(),
      claim.insurance_coverage_id
        ? supabase
            .schema("resupply")
            .from("insurance_coverages")
            .select("member_id")
            .eq("id", claim.insurance_coverage_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      claim.payer_profile_id
        ? supabase
            .schema("resupply")
            .from("payer_profiles")
            .select("appeals_mailing_address")
            .eq("id", claim.payer_profile_id)
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
  if (!patient) return { ok: false, reason: "patient_not_found" };

  const identity = await resolveBillingIdentity({ supabase });
  if (identity.source === "stub") {
    return { ok: false, reason: "no_dme_organization" };
  }
  const payerAddressLines = parsePayerAddressLines(
    (payerProfile as { appeals_mailing_address?: string | null } | null)
      ?.appeals_mailing_address,
  );

  const pdf = await renderAppealPdf({
    payerName: claim.payer_name,
    payerAddressLines: payerAddressLines ?? undefined,
    claimNumber: claim.claim_number,
    patientName: `${patient.legal_first_name} ${patient.legal_last_name}`,
    patientMemberId:
      (coverage as { member_id?: string } | null)?.member_id ??
      "(see attached EOB)",
    dateOfService: claim.date_of_service,
    denialReason: claim.denial_reason,
    letterBody: letter.letter_body,
    signerName: identity.organization?.authorized_signer_name ?? "Billing Team",
    signerTitle:
      identity.organization?.authorized_signer_title ?? "Billing Department",
    dmeOrganization: {
      legalName:
        identity.organization?.legal_name ??
        identity.billingProvider.organizationName,
      addressLine1: identity.billingProvider.address.line1,
      city: identity.billingProvider.address.city,
      state: identity.billingProvider.address.state,
      zip: identity.billingProvider.address.zip,
      phoneE164: identity.organization?.phone_e164 ?? "+10000000000",
      billingEmail:
        identity.organization?.billing_email ?? "billing@example.com",
    },
  });

  return { ok: true, pdf, claimId: claim.id, patientId: claim.patient_id };
}
