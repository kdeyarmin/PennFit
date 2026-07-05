// Resolves the CompanyProfile used to fill in patient-packet document
// content from the DME organization billing identity, falling back to
// safe defaults when the org row hasn't been seeded (dev / preview).

import type { OrgScopedClient } from "@workspace/resupply-db";

import { resolveBillingIdentity } from "../billing/identity-resolver";
import { logger } from "../logger";
import { FALLBACK_COMPANY, type CompanyProfile } from "./templates";

type SupabaseClient = OrgScopedClient;

export async function resolveCompanyProfile(
  supabase: SupabaseClient,
): Promise<CompanyProfile> {
  try {
    const identity = await resolveBillingIdentity({ orgId: supabase.orgId });
    const org = identity.organization;
    const bp = identity.billingProvider;

    // A real `dme_organization` row always wins, independent of
    // `identity.source` — the resolver's `source` reflects whether the
    // CLEARINGHOUSE side (Office Ally credentials / env) is configured,
    // not whether the org itself is real. A tenant can seed its company
    // info before ever touching clearinghouse setup, in which case `org`
    // is fully real but `source` still reads "stub" (or "env") and `bp`
    // is `stubBillingProvider()`'s sentinel values ("STUB", npi
    // "0000000000", etc) — reading address/npi/name off `bp` in that
    // case would brand patient packets with garbage despite a perfectly
    // good org row being on file. So: prefer `org`'s own fields wholesale
    // whenever it exists, and only fall through to `bp` (env identity or
    // the stub sentinel) when there is no org row at all.
    if (org) {
      const cityStateZip =
        org.physical_city && org.physical_state
          ? `${org.physical_city}, ${org.physical_state} ${org.physical_zip ?? ""}`.trim()
          : "";
      return {
        legalName: org.legal_name,
        phone: org.phone_e164 ?? FALLBACK_COMPANY.phone,
        email: org.billing_email ?? FALLBACK_COMPANY.email,
        addressLine1: org.physical_address_line1 ?? "",
        cityStateZip,
        npi: org.organizational_npi ?? null,
      };
    }

    // No org row on file. `source === "stub"` here means bp is the
    // literal sentinel ("STUB BILLING PROVIDER (CONFIGURE
    // dme_organization)", npi "0000000000", …) — never use that as a
    // patient-facing company name. `source === "env"` means bp is a
    // legitimate operator-configured identity (OFFICE_ALLY_BILLING_*),
    // safe to use.
    if (identity.source === "stub") return FALLBACK_COMPANY;
    const legalName = bp.organizationName;
    if (!legalName) return FALLBACK_COMPANY;
    const cityStateZip =
      bp.address.city && bp.address.state
        ? `${bp.address.city}, ${bp.address.state} ${bp.address.zip ?? ""}`.trim()
        : "";
    return {
      legalName,
      phone: FALLBACK_COMPANY.phone,
      email: FALLBACK_COMPANY.email,
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
