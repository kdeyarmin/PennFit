// Resolves the CompanyProfile used to fill in patient-packet document
// content from the DME organization billing identity, falling back to
// safe defaults when the org row hasn't been seeded (dev / preview).

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../billing/identity-resolver";
import { logger } from "../logger";
import { FALLBACK_COMPANY, type CompanyProfile } from "./templates";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export async function resolveCompanyProfile(
  supabase: SupabaseClient,
): Promise<CompanyProfile> {
  try {
    const identity = await resolveBillingIdentity({ supabase });
    const org = identity.organization;
    const bp = identity.billingProvider;
    const legalName = org?.legal_name ?? bp.organizationName;
    if (!legalName) return FALLBACK_COMPANY;
    const cityStateZip =
      bp.address.city && bp.address.state
        ? `${bp.address.city}, ${bp.address.state} ${bp.address.zip ?? ""}`.trim()
        : "";
    return {
      legalName,
      phone: org?.phone_e164 ?? FALLBACK_COMPANY.phone,
      email: org?.billing_email ?? FALLBACK_COMPANY.email,
      addressLine1: bp.address.line1 ?? "",
      cityStateZip,
      npi: bp.npi ?? null,
    };
  } catch (err) {
    logger.warn(
      { err },
      "patient-packet: company profile resolution failed; using fallback",
    );
    return FALLBACK_COMPANY;
  }
}
