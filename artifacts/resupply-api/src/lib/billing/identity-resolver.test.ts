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

// resolveSeedOrgId() reads `organizations` by the seed slug; stage it so the
// resolvers resolve a concrete seed org and read the (org-scoped) DB rows.
const SEED_ORG_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000000b2";

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
  // Seed-org directory lookup for resolveSeedOrgId(). Cached after the first
  // resolve, but stage every test so order doesn't matter.
  stageSupabaseResponse("organizations", "select", {
    data: { id: SEED_ORG_ID },
  });
});

describe("resolveBillingIdentity", () => {
  it("returns source='db' when both org + clearinghouse rows exist", async () => {
    stageSupabaseResponse("dme_organization", "select", {
      data: {
        id: "org_1",
        singleton: true,
        legal_name: "Penn Home Medical Supply Inc",
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
        submitter_organization_name: "Penn Home Medical Supply Inc Submitter",
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
    // No location passed → org scope, unchanged from before this feature.
    expect(result.billingProviderScope).toBe("org");
    expect(result.locationId).toBeNull();
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

  it("does NOT use the seed env identity for a NON-seed tenant (fail closed)", async () => {
    // Regression (multi-tenant #1): the env vars carry the seed tenant's NPI.
    // A second tenant with no DB identity of its own must fail closed to a
    // STUB — never silently build its 837P under the seed NPI.
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveBillingIdentity({
      orgId: OTHER_ORG_ID,
      env: { ...FULL_ENV },
    });
    expect(result.source).toBe("stub");
    expect(result.billingProvider.npi).toBe("0000000000");
  });
});

describe("resolveBillingIdentity — multi-location Phase 1 overlay", () => {
  const LOCATION_ID = "00000000-0000-4000-8000-0000000000c3";

  // A complete org-level DB identity (NPI 9999999999) shared by these tests
  // as the BASE the overlay either keeps or replaces.
  const ORG_ROW = {
    id: "org_1",
    singleton: true,
    legal_name: "Penn Home Medical Supply Inc",
    organizational_npi: "9999999999",
    tax_id: "999999999",
    physical_address_line1: "1 Penn Plaza",
    physical_city: "Philadelphia",
    physical_state: "PA",
    physical_zip: "19103",
    phone_e164: "+18001234567",
  } as const;
  const CH_ROW = {
    id: "ch_1",
    slug: "office_ally",
    etin: "DBETIN",
    usage_indicator: "P",
    submitter_organization_name: "Penn Home Medical Supply Inc Submitter",
    contact_name: "Billing",
    contact_phone_e164: "+18005550100",
    sftp_host: "h",
    sftp_port: 22,
    sftp_username: "u",
    private_key_path: "/k",
    known_hosts_path: "/kh",
    remote_inbox_dir: "in",
  } as const;

  function stageOrgIdentity() {
    stageSupabaseResponse("dme_organization", "select", {
      data: { ...ORG_ROW },
    });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: { ...CH_ROW },
    });
  }

  // Each test that exercises the flag uses a UNIQUE orgId so the per-(org,key)
  // feature-flag cache never leaks a value across tests.
  function freshOrgId(suffix: string): string {
    return `00000000-0000-4000-8000-0000000000${suffix}`;
  }

  it("(a) flag OFF → returns the org identity unchanged (no overlay)", async () => {
    const orgId = freshOrgId("d0");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    // multi_location.enabled OFF for this tenant.
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("org");
    expect(result.locationId).toBeNull();
    // Org NPI, NOT the branch NPI.
    expect(result.billingProvider.npi).toBe("9999999999");
  });

  it("(b) no locationId passed → org identity even with flag ON", async () => {
    const orgId = freshOrgId("d1");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    // Flag could be ON, but no location is supplied → no branch read happens.
    const result = await resolveBillingIdentity({ orgId, env: {} });
    expect(result.billingProviderScope).toBe("org");
    expect(result.locationId).toBeNull();
    expect(result.billingProvider.npi).toBe("9999999999");
  });

  it("(c) flag ON + location with its own NPI → location identity", async () => {
    const orgId = freshOrgId("d2");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("locations", "select", {
      data: {
        id: LOCATION_ID,
        name: "West Branch",
        npi: "1212121212",
        is_active: true,
        billing_legal_name: "Penn Home Medical Supply West LLC",
        billing_tax_id: "222222222",
        billing_address_line1: "9 West Ave",
        billing_city: "Pittsburgh",
        billing_state: "PA",
        billing_zip: "15201",
      },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("location");
    expect(result.locationId).toBe(LOCATION_ID);
    // Branch NPI/name/taxId/address overlaid.
    expect(result.billingProvider.npi).toBe("1212121212");
    expect(result.billingProvider.organizationName).toBe(
      "Penn Home Medical Supply West LLC",
    );
    expect(result.billingProvider.taxId).toBe("222222222");
    expect(result.billingProvider.address.line1).toBe("9 West Ave");
    expect(result.billingProvider.address.zip).toBe("15201");
    // The submitter (EDI account) + usageIndicator + source stay org-level.
    expect(result.submitter.etin).toBe("DBETIN");
    expect(result.usageIndicator).toBe("P");
    expect(result.source).toBe("db");
  });

  it("(d) flag ON + location WITHOUT a billing NPI → org fallback", async () => {
    const orgId = freshOrgId("d3");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    // Branch row exists but carries no NPI → not a billing identity.
    stageSupabaseResponse("locations", "select", {
      data: {
        id: LOCATION_ID,
        name: "Annex (no billing identity)",
        npi: null,
        is_active: true,
        billing_legal_name: null,
      },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("org");
    expect(result.locationId).toBeNull();
    expect(result.billingProvider.npi).toBe("9999999999");
  });

  it("flag ON + missing location row → org fallback", async () => {
    const orgId = freshOrgId("d4");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("locations", "select", { data: null });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("org");
    expect(result.billingProvider.npi).toBe("9999999999");
  });

  it("never overlays onto a STUB org identity (fail closed)", async () => {
    const orgId = freshOrgId("d5");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    // No org/clearinghouse → base is a stub. A branch cannot bill if the org
    // is unconfigured: the overlay must not run (it short-circuits on stub).
    stageSupabaseResponse("dme_organization", "select", { data: null });
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.source).toBe("stub");
    expect(result.billingProviderScope).toBe("org");
    expect(result.billingProvider.npi).toBe("0000000000");
  });

  it("partially-configured branch (NPI only) fills missing fields from org", async () => {
    const orgId = freshOrgId("d6");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    // Branch has an NPI but no billing legal name / tax id / address.
    stageSupabaseResponse("locations", "select", {
      data: {
        id: LOCATION_ID,
        name: "East Branch",
        npi: "3434343434",
        is_active: true,
        billing_legal_name: null,
        billing_tax_id: null,
        billing_address_line1: null,
        address_line1: null,
      },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("location");
    expect(result.billingProvider.npi).toBe("3434343434");
    // Falls back to the branch name, then org legal/tax/address per field.
    expect(result.billingProvider.organizationName).toBe("East Branch");
    expect(result.billingProvider.taxId).toBe("999999999");
    // No branch address line1 at all → keep the org address wholesale.
    expect(result.billingProvider.address.line1).toBe("1 Penn Plaza");
    expect(result.billingProvider.address.zip).toBe("19103");
  });

  it("branch with line1 but missing city/state/zip fills EACH from the org address", async () => {
    // Regression (PR #1210 P2): a branch that supplies a billing_address_line1
    // but omits city/state/zip must NOT emit empty N4 elements — each missing
    // field falls back PER FIELD to the org address (not all-or-nothing).
    const orgId = freshOrgId("d7");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("locations", "select", {
      data: {
        id: LOCATION_ID,
        name: "South Branch",
        npi: "5656565656",
        is_active: true,
        // A real branch billing line1, but city/state/zip omitted entirely.
        billing_address_line1: "42 South St",
        billing_address_line2: null,
        billing_city: null,
        billing_state: null,
        billing_zip: null,
        address_line1: null,
        city: null,
        state: null,
        postal_code: null,
      },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("location");
    // The branch line1 is used …
    expect(result.billingProvider.address.line1).toBe("42 South St");
    // … but the missing city/state/zip each fall back to the org address,
    // never an empty string.
    expect(result.billingProvider.address.city).toBe("Philadelphia");
    expect(result.billingProvider.address.state).toBe("PA");
    expect(result.billingProvider.address.zip).toBe("19103");
    // No line2 supplied → none applied.
    expect(result.billingProvider.address.line2).toBeUndefined();
  });

  it("applies billing_address_line2 to the branch billing address", async () => {
    // Regression (PR #1210 P2): billing_address_line2 was selected but never
    // applied to the returned BillingProvider.address.
    const orgId = freshOrgId("d8");
    stageSupabaseResponse("organizations", "select", { data: { id: orgId } });
    stageOrgIdentity();
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    stageSupabaseResponse("locations", "select", {
      data: {
        id: LOCATION_ID,
        name: "North Branch",
        npi: "7878787878",
        is_active: true,
        billing_address_line1: "9 North Ave",
        billing_address_line2: "Suite 200",
        billing_city: "Pittsburgh",
        billing_state: "PA",
        billing_zip: "15201",
      },
    });
    const result = await resolveBillingIdentity({
      orgId,
      locationId: LOCATION_ID,
      env: {},
    });
    expect(result.billingProviderScope).toBe("location");
    expect(result.billingProvider.address.line1).toBe("9 North Ave");
    expect(result.billingProvider.address.line2).toBe("Suite 200");
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
        submitter_organization_name: "Penn Home Medical Supply",
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

  it("does NOT use the seed env SFTP transport for a NON-seed tenant (fail closed)", async () => {
    // Regression (multi-tenant #2): the OFFICE_ALLY_* SFTP env is the seed
    // tenant's account. A non-seed tenant without its own clearinghouse row
    // must fail closed (no transport) rather than upload over the seed SFTP.
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveClearinghouse({
      orgId: OTHER_ORG_ID,
      env: { ...FULL_ENV },
    });
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

describe("resolveClearinghouse — real-time eligibility config", () => {
  // The realtime_password column carries the REST API key (sent in the
  // Authorization header).
  const REALTIME_ROW = {
    id: "ch_1",
    slug: "office_ally",
    etin: "DBETIN",
    usage_indicator: "T",
    sftp_host: "h",
    sftp_port: 22,
    sftp_username: "u",
    private_key_path: "/k",
    known_hosts_path: "/kh",
    remote_inbox_dir: "inbound",
    realtime_enabled: true,
    realtime_url: "https://edi.officeally.io/v2/eligibility-benefits/x12",
    realtime_username: null,
    realtime_sender_id: null,
    realtime_receiver_id: null,
    realtime_timeout_ms: null,
    realtime_password: null,
  } as const;

  it("builds realtimeConfig from the DB row + env api key", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: REALTIME_ROW,
    });
    const result = await resolveClearinghouse({
      env: { OFFICE_ALLY_REALTIME_API_KEY: "key123" },
    });
    expect(result.realtimeConfig).not.toBeNull();
    expect(result.realtimeConfig?.url).toBe(REALTIME_ROW.realtime_url);
    expect(result.realtimeConfig?.apiKey).toBe("key123");
    expect(result.realtimeConfig?.timeoutMs).toBe(30000);
  });

  it("returns null realtimeConfig when no api key is available", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: REALTIME_ROW,
    });
    const result = await resolveClearinghouse({ env: {} });
    expect(result.realtimeConfig).toBeNull();
  });

  it("rejects a DB realtime_url that is not an https officeally.io host (SSRF/PHI guard)", async () => {
    // The 270 carries PHI + the API key in the Authorization header, so an
    // operator-supplied DB URL must pass the SAME allowlist the env path and
    // discovery path enforce — a malicious/typo'd host fails closed.
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: {
        ...REALTIME_ROW,
        realtime_url: "https://attacker.example/collect",
      },
    });
    const result = await resolveClearinghouse({
      env: { OFFICE_ALLY_REALTIME_API_KEY: "key123" },
    });
    expect(result.realtimeConfig).toBeNull();
  });

  it("returns null realtimeConfig in stub mode even with the api key set", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: REALTIME_ROW,
    });
    const result = await resolveClearinghouse({
      env: { OFFICE_ALLY_REALTIME_API_KEY: "key123", OFFICE_ALLY_STUB: "1" },
    });
    expect(result.realtimeConfig).toBeNull();
  });

  it("falls back to the fully-env real-time path when no DB row exists", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: null,
    });
    const result = await resolveClearinghouse({
      env: {
        ...FULL_ENV,
        // Must be an https *.officeally.io host — the realtime config reader
        // rejects any other host so the 270 (PHI) can't be POSTed in cleartext
        // or to an SSRF target (see readOfficeAllyRealtimeConfigOrNull).
        OFFICE_ALLY_REALTIME_URL: "https://edi.officeally.io/env-rt",
        OFFICE_ALLY_REALTIME_API_KEY: "envkey",
      },
    });
    expect(result.source).toBe("env");
    expect(result.realtimeConfig?.url).toBe("https://edi.officeally.io/env-rt");
    expect(result.realtimeConfig?.apiKey).toBe("envkey");
  });

  it("uses the DB row's stored api key, and its timeout when set", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: {
        ...REALTIME_ROW,
        realtime_password: "dbkey",
        realtime_timeout_ms: 9000,
      },
    });
    const result = await resolveClearinghouse({ env: {} });
    expect(result.realtimeConfig?.apiKey).toBe("dbkey");
    expect(result.realtimeConfig?.timeoutMs).toBe(9000);
  });

  it("prefers the DB row's stored api key over the env var", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: { ...REALTIME_ROW, realtime_password: "dbkey" },
    });
    const result = await resolveClearinghouse({
      env: { OFFICE_ALLY_REALTIME_API_KEY: "envkey" },
    });
    expect(result.realtimeConfig?.apiKey).toBe("dbkey");
  });

  it("falls back to the legacy OFFICE_ALLY_REALTIME_PASSWORD for the api key", async () => {
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: REALTIME_ROW,
    });
    const result = await resolveClearinghouse({
      env: { OFFICE_ALLY_REALTIME_PASSWORD: "legacykey" },
    });
    expect(result.realtimeConfig?.apiKey).toBe("legacykey");
  });

  it("does NOT let env vars re-enable real-time when the DB row has it disabled", async () => {
    // The admin toggle is off — env vars must not silently turn it back on.
    stageSupabaseResponse("clearinghouse_credentials", "select", {
      data: { ...REALTIME_ROW, realtime_enabled: false },
    });
    const result = await resolveClearinghouse({
      env: {
        // Valid host so the ONLY reason realtimeConfig is null is the DB
        // "disabled" toggle — not URL rejection.
        OFFICE_ALLY_REALTIME_URL: "https://edi.officeally.io/env-rt",
        OFFICE_ALLY_REALTIME_API_KEY: "envkey",
      },
    });
    expect(result.realtimeConfig).toBeNull();
  });
});
