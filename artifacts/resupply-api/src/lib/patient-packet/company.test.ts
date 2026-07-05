// Tests for resolveCompanyProfile — the CompanyProfile used to fill in
// patient-packet emails and signed documents.
//
// Regression coverage:
//   * dme_organization unseeded + no clearinghouse/env fallback →
//     resolveBillingIdentity() returns a "stub" identity whose
//     billingProvider.organizationName is the literal sentinel string
//     "STUB BILLING PROVIDER (CONFIGURE dme_organization)". That string
//     is non-empty, so it must NOT be allowed to pass through as a
//     patient-facing company name (e.g. leaking into an email subject
//     like "Reminder: please sign your STUB BILLING PROVIDER (CONFIGURE
//     dme_organization) new patient documents").
//   * dme_organization SEEDED but clearinghouse_credentials missing (and
//     no env fallback) — resolveBillingIdentity() ALSO returns
//     source: "stub" in this case (it reflects the clearinghouse side,
//     not just the org), but `identity.organization` is still the real
//     row. The real org's name/address/phone/email/NPI must win here,
//     not the stub sentinel and not FALLBACK_COMPANY.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getOrgScopedClient, __resetSeedOrgIdForTests } from "@workspace/resupply-db";

import { resolveCompanyProfile } from "./company";
import { FALLBACK_COMPANY } from "./templates";

const SEED_ORG_ID = "00000000-0000-4000-8000-000000000001";

// resolveBillingIdentity() only takes the env fallback path when EVERY one
// of these is set (see envBillingProvider / envSubmitter_ in
// identity-resolver.ts). Clearing them for the duration of this file makes
// the "stub" tests deterministic regardless of ambient process.env — an
// operator's real .env, or a leftover stub from another test file, would
// otherwise silently flip these to source: "env" instead of "stub".
const OFFICE_ALLY_ENV_KEYS = [
  "OFFICE_ALLY_ETIN",
  "OFFICE_ALLY_BILLING_ORG_NAME",
  "OFFICE_ALLY_BILLING_NPI",
  "OFFICE_ALLY_BILLING_TAX_ID",
  "OFFICE_ALLY_BILLING_ADDRESS_LINE1",
  "OFFICE_ALLY_BILLING_CITY",
  "OFFICE_ALLY_BILLING_STATE",
  "OFFICE_ALLY_BILLING_ZIP",
] as const;
const originalEnv: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  supabaseMock.reset();
  // resolveSeedOrgId() caches across calls; reset it so each test's staged
  // `organizations` response resolves freshly rather than an earlier test's.
  __resetSeedOrgIdForTests();
  stageSupabaseResponse("organizations", "select", {
    data: { id: SEED_ORG_ID },
  });
  for (const k of OFFICE_ALLY_ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of OFFICE_ALLY_ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
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

  it("uses the real org's own fields — not the stub sentinel — when clearinghouse_credentials isn't configured yet", async () => {
    // A tenant can seed its company info (dme_organization) before ever
    // touching Office Ally / clearinghouse setup. resolveBillingIdentity()
    // still reports source: "stub" in that state (its `source` describes
    // clearinghouse readiness, not org readiness), and its `billingProvider`
    // is the "STUB ..." sentinel with a fake address/NPI — but
    // `identity.organization` is the real row. The real row must win.
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
      data: null,
    });
    const supabase = getOrgScopedClient(SEED_ORG_ID);
    const company = await resolveCompanyProfile(supabase);
    expect(company.legalName).toBe("Acme DME LLC");
    expect(company.legalName).not.toContain("STUB");
    expect(company.cityStateZip).toBe("Pittsburgh, PA 15201");
    expect(company.addressLine1).toBe("1 Main St");
    expect(company.npi).toBe("9999999999");
    expect(company.phone).toBe("+18001234567");
    expect(company.email).toBe("billing@acmedme.example");
  });
});
