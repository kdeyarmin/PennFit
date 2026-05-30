// Tests for the billing identity resolver.
//
// Coverage:
//   * Returns source='db' when both organization + clearinghouse rows present
//   * Returns source='env' when DB rows are missing but env is fully set
//   * Returns source='stub' with sentinel values when neither DB nor env present
//   * resolveClearinghouse returns source='db' when row exists
//   * resolveClearinghouse uses env path when DB row missing but env present
//   * resolveClearinghouse returns null config when neither set
//   * Stub billing provider has clearly-marked sentinel NPI (0000000000)

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  resolveBillingIdentity,
  resolveClearinghouse,
} from "./identity-resolver";

const FULL_ENV = {
  OFFICE_ALLY_ETIN: "12345ETIN",
  OFFICE_ALLY_BILLING_ORG_NAME: "EnvDME LLC",
  OFFICE_ALLY_BILLING_NPI: "1111111111",
  OFFICE_ALLY_BILLING_TAX_ID: "111111111",
  OFFICE_ALLY_BILLING_ADDRESS_LINE1: "1 Main St",
  OFFICE_ALLY_BILLING_CITY: "Pittsburgh",
  OFFICE_ALLY_BILLING_STATE: "PA",
  OFFICE_ALLY_BILLING_ZIP: "15201",
  OFFICE_ALLY_USERNAME: "oa_user",
  OFFICE_ALLY_PRIVATE_KEY_PATH: "/keys/id",
  OFFICE_ALLY_KNOWN_HOSTS_PATH: "/keys/known",
} as const;

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveBillingIdentity", () => {
  it("returns source='db' when both org + clearinghouse rows exist", async () => {
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        id: "org_1",
        singleton: true,
        legal_name: "PennPaps Inc",
        organizational_npi: "9999999999",
        tax_id: "999999999",
        physical_address_line1: "1 Penn Plaza",
        physical_city: "Philadelphia",
        physical_state: "PA",
        physical_zip: "19103",
        phone_e164: "+18001234567",
      },
    });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: {
        id: "ch_1",
        slug: "office_ally",
        etin: "DBETIN",
        usage_indicator: "P",
        submitter_organization_name: "PennPaps Inc Submitter",
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
    const result = await resolveBillingIdentity({ env: {} });
    expect(result.source).toBe("db");
    expect(result.billingProvider.npi).toBe("9999999999");
    expect(result.submitter.etin).toBe("DBETIN");
    expect(result.usageIndicator).toBe("P");
  });

  it("returns source='env' when DB rows are absent but env is complete", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveBillingIdentity({ env: { ...FULL_ENV } });
    expect(result.source).toBe("env");
    expect(result.billingProvider.organizationName).toBe("EnvDME LLC");
    expect(result.submitter.etin).toBe("12345ETIN");
    expect(result.usageIndicator).toBe("T");
  });

  it("uses P usage indicator when OFFICE_ALLY_USAGE_INDICATOR='P'", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveBillingIdentity({
      env: { ...FULL_ENV, OFFICE_ALLY_USAGE_INDICATOR: "P" },
    });
    expect(result.usageIndicator).toBe("P");
  });

  it("returns source='stub' with sentinel NPI when neither DB nor env present", async () => {
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveBillingIdentity({ env: {} });
    expect(result.source).toBe("stub");
    // Sentinel NPI must be all zeros so a deploy never silently bills
    // against a real number.
    expect(result.billingProvider.npi).toBe("0000000000");
    expect(result.usageIndicator).toBe("T");
    expect(result.submitter.organizationName).toContain("STUB");
  });
});

describe("resolveClearinghouse", () => {
  it("returns source='db' when clearinghouse row exists", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: {
        id: "ch_1",
        slug: "office_ally",
        etin: "DBETIN",
        usage_indicator: "P",
        submitter_organization_name: "PennPaps",
        contact_name: "Billing",
        contact_phone_e164: "+18005550100",
        sftp_host: "h",
        sftp_port: 22,
        sftp_username: "u",
        private_key_path: "/k",
        known_hosts_path: "/kh",
        remote_inbox_dir: "inbound",
      },
    });
    const result = await resolveClearinghouse({ env: {} });
    expect(result.source).toBe("db");
    expect(result.config?.host).toBe("h");
    expect(result.config?.privateKeyPath).toBe("/k");
  });

  it("returns source='env' with parsed SFTP config when DB row missing", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveClearinghouse({ env: { ...FULL_ENV } });
    expect(result.source).toBe("env");
    expect(result.config?.host).toBe("sftp10.officeally.com");
    expect(result.config?.username).toBe("oa_user");
    expect(result.config?.port).toBe(22);
  });

  it("returns null config and source='stub' when neither DB nor env set", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveClearinghouse({ env: {} });
    expect(result.source).toBe("stub");
    expect(result.config).toBeNull();
  });

  it("falls back to default port 22 on malformed OFFICE_ALLY_PORT", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveClearinghouse({
      env: { ...FULL_ENV, OFFICE_ALLY_PORT: "not-a-port" },
    });
    expect(result.config?.port).toBe(22);
  });
});
