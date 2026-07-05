// Tests for resolveCompanyProfile — the CompanyProfile used to fill in
// patient-packet emails and signed documents.
//
// Regression coverage: when dme_organization is unseeded and no env
// fallback is configured, resolveBillingIdentity() returns a "stub"
// identity whose billingProvider.organizationName is the literal
// sentinel string "STUB BILLING PROVIDER (CONFIGURE dme_organization)".
// That string is non-empty, so it must NOT be allowed to pass through
// as a patient-facing company name (e.g. leaking into an email subject
// like "Reminder: please sign your STUB BILLING PROVIDER (CONFIGURE
// dme_organization) new patient documents").

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getOrgScopedClient } from "@workspace/resupply-db";

import { resolveCompanyProfile } from "./company";
import { FALLBACK_COMPANY } from "./templates";

const SEED_ORG_ID = "00000000-0000-4000-8000-000000000001";

beforeEach(() => {
  supabaseMock.reset();
  stageSupabaseResponse("organizations", "select", {
    data: { id: SEED_ORG_ID },
  });
});

describe("resolveCompanyProfile", () => {
  it("falls back to FALLBACK_COMPANY (never the stub sentinel) when dme_organization is unseeded", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const supabase = getOrgScopedClient(SEED_ORG_ID);
    const company = await resolveCompanyProfile(supabase);
    expect(company).toEqual(FALLBACK_COMPANY);
    expect(company.legalName).not.toContain("STUB");
  });

  it("uses the DB org's legal_name when dme_organization is seeded", async () => {
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        id: "org_1",
        singleton: true,
        legal_name: "Acme DME LLC",
        organizational_npi: "9999999999",
        tax_id: "999999999",
        physical_address_line1: "1 Main St",
        physical_city: "Pittsburgh",
        physical_state: "PA",
        physical_zip: "15201",
        phone_e164: "+18001234567",
        billing_email: "billing@acmedme.example",
      },
    });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: {
        id: "ch_1",
        slug: "office_ally",
        etin: "DBETIN",
        usage_indicator: "P",
        submitter_organization_name: "Acme DME LLC Submitter",
        contact_name: "Billing",
        contact_phone_e164: "+18005550100",
        sftp_host: "h",
        sftp_port: 22,
        sftp_username: "u",
        private_key_path: "/k",
        known_hosts_path: "/kh",
        remote_inbox_dir: "in",
      },
    });
    const supabase = getOrgScopedClient(SEED_ORG_ID);
    const company = await resolveCompanyProfile(supabase);
    expect(company.legalName).toBe("Acme DME LLC");
    expect(company.cityStateZip).toBe("Pittsburgh, PA 15201");
  });
});
