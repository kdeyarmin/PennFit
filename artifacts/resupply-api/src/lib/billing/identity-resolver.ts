// Identity resolver — single source of truth for "who are we" and
// "which clearinghouse are we billing through" at runtime.
//
// Resolution order (highest priority first):
//   1. The DB row (dme_organization / clearinghouse_credentials).
//      This is the editable source the admin UI writes to.
//   2. The OFFICE_ALLY_* env vars (legacy path; preserved for
//      dev / preview where the DB row hasn't been seeded).
//   3. Stub values clearly marked as such so a misconfigured prod
//      deploy never silently bills the wrong NPI.
//
// The 837P builder + HCFA PDF generator + auto-resubmit pipeline all
// call resolveBillingIdentity() instead of reading env vars directly.

import {
  type Database,
  getOrgScopedClient,
  type OrgScopedClient,
  resolveSeedOrgId,
} from "@workspace/resupply-db";
import {
  readOfficeAllyRealtimeConfigOrNull,
  readOfficeAllyDiscoveryConfigOrNull,
  type BillingProvider,
  type OfficeAllyDiscoveryConfig,
  type OfficeAllyRealtimeConfig,
  type SftpTransportConfig,
  type SubmitterIdentity,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";

type OrgRow = Database["resupply"]["Tables"]["dme_organization"]["Row"];
type ClearinghouseRow =
  Database["resupply"]["Tables"]["clearinghouse_credentials"]["Row"];

export interface ResolvedBillingIdentity {
  source: "db" | "env" | "stub";
  organization: OrgRow | null;
  billingProvider: BillingProvider;
  submitter: SubmitterIdentity;
  usageIndicator: "P" | "T";
}

export interface ResolvedClearinghouse {
  source: "db" | "env" | "stub";
  /** Null when neither DB row nor env are set. */
  config: SftpTransportConfig | null;
  /** Real-time eligibility (270/271) config, or null when not enabled.
   *  Built from the DB row's non-secret fields + the
   *  OFFICE_ALLY_REALTIME_PASSWORD env secret, falling back to the
   *  fully-env path. Independent of the SFTP `config` above. */
  realtimeConfig: OfficeAllyRealtimeConfig | null;
  /** Insurance discovery config, or null when not enabled. Reuses the
   *  real-time API key (same Office Ally EDI account) with its own endpoint
   *  URL + on/off toggle. Independent of `realtimeConfig`. */
  discoveryConfig: OfficeAllyDiscoveryConfig | null;
  /** Null when DB row absent. */
  row: ClearinghouseRow | null;
  usageIndicator: "P" | "T";
  submitter: SubmitterIdentity;
}

export async function resolveBillingIdentity(
  opts: {
    /** Tenant for the org-scoped clearinghouse read. Defaults to the
     *  seed org (single-tenant bridge). dme_organization is a global
     *  singleton and is always read via the unscoped client. */
    orgId?: string;
    env?: NodeJS.ProcessEnv;
    clearinghouseSlug?: string;
  } = {},
): Promise<ResolvedBillingIdentity> {
  const env = opts.env ?? process.env;
  const clearinghouseSlug = opts.clearinghouseSlug ?? "office_ally";
  const seedOrgId = await resolveSeedOrgId();
  const orgId = opts.orgId ?? seedOrgId;
  const scoped = orgId ? getOrgScopedClient(orgId) : null;
  // The OFFICE_ALLY_* / billing env vars carry the PLATFORM (seed) tenant's
  // identity. They must NEVER stand in for a DIFFERENT tenant — otherwise a
  // second tenant's 837P would be built under the seed NPI/PTAN. So the env
  // fallback below is gated to the seed org; a non-seed tenant with no DB
  // identity of its own fails closed to a STUB the submit path refuses.
  // "No org resolved at all" (orgId null — local dev / no tenant directory)
  // counts as seed: there is no specific tenant to mis-bill. A CONCRETE
  // non-seed org never gets the env fallback, even if the seed lookup fails.
  const isSeedOrg = !orgId || (!!seedOrgId && orgId === seedOrgId);

  // 1. Try the DB. Both dme_organization and clearinghouse_credentials are
  //    org-scoped: read each through the tenant-scoped client so tenant #2
  //    bills under ITS OWN identity, never the seed singleton.
  const org = scoped ? await loadOrganization(scoped) : null;
  const ch = scoped ? await loadClearinghouse(scoped, clearinghouseSlug) : null;

  if (org && ch) {
    return {
      source: "db",
      organization: org,
      billingProvider: orgToBillingProvider(org),
      submitter: {
        etin: ch.etin,
        organizationName: ch.submitter_organization_name ?? org.legal_name,
        contactName: ch.contact_name ?? "BILLING",
        contactPhoneE164: ch.contact_phone_e164 ?? org.phone_e164,
      },
      usageIndicator: ch.usage_indicator,
    };
  }

  // 2. Fall back to env (legacy path) — SEED ORG ONLY (see isSeedOrg above).
  const envBilling = isSeedOrg ? envBillingProvider(env) : null;
  const envSubmitter = isSeedOrg ? envSubmitter_(env) : null;
  if (envBilling && envSubmitter) {
    return {
      source: "env",
      organization: org,
      billingProvider: envBilling,
      submitter: envSubmitter,
      usageIndicator: env.OFFICE_ALLY_USAGE_INDICATOR === "P" ? "P" : "T",
    };
  }

  // 3. Final stub — log loudly so a prod deploy never silently bills.
  logger.warn(
    {
      event: "billing_identity_stub",
      hasDbOrg: !!org,
      hasDbClearinghouse: !!ch,
      hasEnvBilling: !!envBilling,
    },
    "billing identity falling back to STUB values; configure dme_organization + clearinghouse_credentials or OFFICE_ALLY_* env",
  );
  return {
    source: "stub",
    organization: org,
    billingProvider: stubBillingProvider(),
    submitter: stubSubmitter(),
    usageIndicator: "T",
  };
}

export async function resolveClearinghouse(
  opts: {
    /** Tenant for the org-scoped clearinghouse_credentials read.
     *  Defaults to the seed org (single-tenant bridge). */
    orgId?: string;
    env?: NodeJS.ProcessEnv;
    slug?: string;
  } = {},
): Promise<ResolvedClearinghouse> {
  const env = opts.env ?? process.env;
  const slug = opts.slug ?? "office_ally";
  const seedOrgId = await resolveSeedOrgId();
  const orgId = opts.orgId ?? seedOrgId;
  const scoped = orgId ? getOrgScopedClient(orgId) : null;
  // The OFFICE_ALLY_* SFTP env vars are the seed tenant's transport — never
  // upload a different tenant's 837P over them. A non-seed tenant without its
  // own clearinghouse_credentials row fails closed to a STUB (no transport).
  // orgId null (dev / no tenant directory) counts as seed; a concrete
  // non-seed org never gets the env transport.
  const isSeedOrg = !orgId || (!!seedOrgId && orgId === seedOrgId);
  const row = scoped ? await loadClearinghouse(scoped, slug) : null;
  // Real-time config is independent of the SFTP path — compute it once
  // from (row, env) and surface it in every branch.
  // Gate the env to the seed org here too: when a non-seed tenant has no DB
  // row, buildRealtimeConfig would otherwise fall back to the seed's
  // OFFICE_ALLY_REALTIME_* env and route that tenant's 270 eligibility
  // requests through the SEED tenant's Office Ally realtime credentials. A
  // non-seed tenant must supply its own realtime creds in its row, or get no
  // realtime (fail closed) — matching the SFTP/billing-identity gate above.
  const realtimeConfig = buildRealtimeConfig(row, isSeedOrg ? env : {});
  // Discovery shares the gate logic: a non-seed tenant with no DB row of its
  // own gets no env fallback (fail closed), exactly like realtime/SFTP above.
  const discoveryConfig = buildDiscoveryConfig(row, isSeedOrg ? env : {});
  if (row) {
    return {
      source: "db",
      row,
      config: {
        host: row.sftp_host,
        port: row.sftp_port,
        username: row.sftp_username,
        privateKeyPath: row.private_key_path,
        knownHostsPath: row.known_hosts_path,
        remoteInboxDir: row.remote_inbox_dir,
      },
      realtimeConfig,
      discoveryConfig,
      usageIndicator: row.usage_indicator,
      submitter: {
        etin: row.etin,
        organizationName: row.submitter_organization_name ?? "PENNPAPS INC",
        contactName: row.contact_name ?? "BILLING",
        contactPhoneE164: row.contact_phone_e164 ?? "+10000000000",
      },
    };
  }
  // Env fallback for the SFTP path — SEED ORG ONLY (see isSeedOrg above).
  if (
    isSeedOrg &&
    env.OFFICE_ALLY_USERNAME &&
    env.OFFICE_ALLY_PRIVATE_KEY_PATH &&
    env.OFFICE_ALLY_KNOWN_HOSTS_PATH
  ) {
    return {
      source: "env",
      row: null,
      config: {
        host: env.OFFICE_ALLY_HOST?.trim() || "sftp10.officeally.com",
        port: parsePort(env.OFFICE_ALLY_PORT),
        username: env.OFFICE_ALLY_USERNAME,
        privateKeyPath: env.OFFICE_ALLY_PRIVATE_KEY_PATH,
        knownHostsPath: env.OFFICE_ALLY_KNOWN_HOSTS_PATH,
        remoteInboxDir: env.OFFICE_ALLY_REMOTE_INBOX?.trim() || "inbound",
      },
      realtimeConfig,
      discoveryConfig,
      usageIndicator: env.OFFICE_ALLY_USAGE_INDICATOR === "P" ? "P" : "T",
      submitter: envSubmitter_(env) ?? stubSubmitter(),
    };
  }
  return {
    source: "stub",
    row: null,
    config: null,
    realtimeConfig,
    discoveryConfig,
    usageIndicator: "T",
    submitter: stubSubmitter(),
  };
}

/**
 * Resolve the real-time eligibility config.
 *
 * A clearinghouse DB row is **authoritative** when present: it decides
 * whether real-time is on (the admin toggle), so an env var can NEVER
 * silently re-enable real-time when the row has it disabled or
 * incompletely configured. The fully-env path
 * (readOfficeAllyRealtimeConfigOrNull) applies ONLY when no DB row exists
 * (dev/preview). Returns null when real-time isn't configured (or stub
 * mode is forced).
 */
function buildRealtimeConfig(
  row: ClearinghouseRow | null,
  env: NodeJS.ProcessEnv,
): OfficeAllyRealtimeConfig | null {
  // Stub mode means "don't transmit anywhere" — honor it here too.
  if (env.OFFICE_ALLY_STUB === "1") return null;
  if (row) {
    // The row owns the on/off decision; don't fall back to env when it's
    // disabled or missing the endpoint.
    if (!row.realtime_enabled || !row.realtime_url) {
      return null;
    }
    // API-key precedence: the DB row's stored key wins (the
    // `realtime_password` column carries the Authorization header value),
    // with OFFICE_ALLY_REALTIME_API_KEY / _PASSWORD as the env fallback
    // (dev/preview). A blank stored value counts as "unset".
    const dbApiKey = row.realtime_password;
    const apiKey =
      dbApiKey && dbApiKey.trim().length > 0
        ? dbApiKey.trim()
        : env.OFFICE_ALLY_REALTIME_API_KEY?.trim() ||
          env.OFFICE_ALLY_REALTIME_PASSWORD?.trim();
    if (!apiKey) return null;
    return {
      url: row.realtime_url,
      apiKey,
      timeoutMs:
        typeof row.realtime_timeout_ms === "number" &&
        row.realtime_timeout_ms > 0
          ? row.realtime_timeout_ms
          : 30_000,
    };
  }
  // No DB row at all → env-only path (dev/preview).
  return readOfficeAllyRealtimeConfigOrNull(env);
}

/**
 * Resolve the insurance-discovery config. Mirrors buildRealtimeConfig: a DB
 * row is authoritative for the on/off decision (the admin `discovery_enabled`
 * toggle) and the endpoint URL, while the API key is shared with the
 * real-time connection (same Office Ally EDI account). The fully-env path
 * (readOfficeAllyDiscoveryConfigOrNull) applies ONLY when no DB row exists
 * (dev/preview). Returns null when discovery isn't configured (or stub mode).
 */
function buildDiscoveryConfig(
  row: ClearinghouseRow | null,
  env: NodeJS.ProcessEnv,
): OfficeAllyDiscoveryConfig | null {
  if (env.OFFICE_ALLY_STUB === "1") return null;
  if (row) {
    if (!row.discovery_enabled || !row.discovery_url) return null;
    // Same API-key precedence as real-time: the row's stored key
    // (realtime_password column) wins, env is the dev/preview fallback.
    const dbApiKey = row.realtime_password;
    const apiKey =
      dbApiKey && dbApiKey.trim().length > 0
        ? dbApiKey.trim()
        : env.OFFICE_ALLY_REALTIME_API_KEY?.trim() ||
          env.OFFICE_ALLY_REALTIME_PASSWORD?.trim();
    if (!apiKey) return null;
    return {
      url: row.discovery_url,
      apiKey,
      timeoutMs:
        typeof row.realtime_timeout_ms === "number" &&
        row.realtime_timeout_ms > 0
          ? row.realtime_timeout_ms
          : 30_000,
    };
  }
  // No DB row at all → env-only path (dev/preview).
  return readOfficeAllyDiscoveryConfigOrNull(env);
}

// ── Loaders ─────────────────────────────────────────────────────────

async function loadOrganization(
  supabase: OrgScopedClient,
): Promise<OrgRow | null> {
  // Org-scoped: the facade auto-appends `.eq("org_id", <tenant>)`, so this
  // reads the CALLER's billing identity, not the global singleton. The seed
  // tenant's row (org_id backfilled in migration 0331) reads exactly as
  // before; a non-seed tenant reads its own row or none.
  const { data, error } = await supabase
    .from("dme_organization")
    .select(
      "id, singleton, legal_name, dba_name, tax_id, organizational_npi, taxonomy_code, medicare_ptan, physical_address_line1, physical_address_line2, physical_city, physical_state, physical_zip, mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_zip, pay_to_address_line1, pay_to_address_line2, pay_to_city, pay_to_state, pay_to_zip, phone_e164, fax_e164, billing_email, general_email, support_email, support_phone_e164, support_hours_text, website_url, accreditation_body, accreditation_number, accreditation_expires_on, state_license_number, state_license_state, state_license_expires_on, liability_carrier, liability_policy_number, liability_expires_on, surety_bond_carrier, surety_bond_amount_cents, surety_bond_expires_on, authorized_signer_name, authorized_signer_title, authorized_signer_signature_object_key, notes, org_id, created_at, updated_at",
    )
    .order("singleton", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message },
      "identity-resolver: dme_organization read failed (treating as missing)",
    );
    return null;
  }
  return data;
}

async function loadClearinghouse(
  supabase: OrgScopedClient,
  slug: string,
): Promise<ClearinghouseRow | null> {
  const { data, error } = await supabase
    .from("clearinghouse_credentials")
    .select(
      "id, slug, display_name, usage_indicator, sftp_host, sftp_port, sftp_username, private_key_path, known_hosts_path, remote_inbox_dir, remote_outbound_dir, remote_archive_dir, etin, submitter_organization_name, contact_name, contact_phone_e164, is_active, last_polled_at, notes, realtime_enabled, realtime_url, realtime_username, realtime_sender_id, realtime_receiver_id, realtime_timeout_ms, realtime_password, discovery_enabled, discovery_url, created_at, updated_at, org_id",
    )
    .eq("slug", slug)
    .eq("is_active", true)
    .order("usage_indicator", { ascending: false }) // P before T
    .limit(1)
    .maybeSingle();
  if (error) {
    logger.warn(
      { err: error.message, slug },
      "identity-resolver: clearinghouse_credentials read failed",
    );
    return null;
  }
  return data;
}

// ── Adapters ────────────────────────────────────────────────────────

function orgToBillingProvider(org: OrgRow): BillingProvider {
  return {
    organizationName: org.legal_name,
    npi: org.organizational_npi,
    taxId: org.tax_id,
    address: {
      line1: org.physical_address_line1,
      city: org.physical_city,
      state: org.physical_state,
      zip: org.physical_zip,
    },
  };
}

function envBillingProvider(env: NodeJS.ProcessEnv): BillingProvider | null {
  const orgName = env.OFFICE_ALLY_BILLING_ORG_NAME;
  const npi = env.OFFICE_ALLY_BILLING_NPI;
  const taxId = env.OFFICE_ALLY_BILLING_TAX_ID;
  const line1 = env.OFFICE_ALLY_BILLING_ADDRESS_LINE1;
  const city = env.OFFICE_ALLY_BILLING_CITY;
  const state = env.OFFICE_ALLY_BILLING_STATE;
  const zip = env.OFFICE_ALLY_BILLING_ZIP;
  if (!orgName || !npi || !taxId || !line1 || !city || !state || !zip) {
    return null;
  }
  return {
    organizationName: orgName,
    npi,
    taxId,
    address: { line1, city, state, zip },
  };
}

function envSubmitter_(env: NodeJS.ProcessEnv): SubmitterIdentity | null {
  const etin = env.OFFICE_ALLY_ETIN;
  const orgName = env.OFFICE_ALLY_BILLING_ORG_NAME;
  if (!etin || !orgName) return null;
  return {
    etin,
    organizationName: orgName,
    contactName: env.OFFICE_ALLY_CONTACT_NAME?.trim() || "BILLING",
    contactPhoneE164:
      env.OFFICE_ALLY_CONTACT_PHONE_E164?.trim() || "+10000000000",
  };
}

function stubBillingProvider(): BillingProvider {
  return {
    organizationName: "STUB BILLING PROVIDER (CONFIGURE dme_organization)",
    npi: "0000000000",
    taxId: "000000000",
    address: { line1: "STUB", city: "STUB", state: "PA", zip: "00000" },
  };
}

function stubSubmitter(): SubmitterIdentity {
  return {
    etin: "STUBETIN",
    organizationName: "STUB SUBMITTER (CONFIGURE clearinghouse_credentials)",
    contactName: "STUB",
    contactPhoneE164: "+10000000000",
  };
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 22;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return 22;
  return n;
}
