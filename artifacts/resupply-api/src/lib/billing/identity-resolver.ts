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
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  readOfficeAllyRealtimeConfigOrNull,
  type BillingProvider,
  type OfficeAllyRealtimeConfig,
  type SftpTransportConfig,
  type SubmitterIdentity,
} from "@workspace/resupply-integrations-office-ally";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
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
  /** Null when DB row absent. */
  row: ClearinghouseRow | null;
  usageIndicator: "P" | "T";
  submitter: SubmitterIdentity;
}

export async function resolveBillingIdentity(
  opts: {
    supabase?: SupabaseClient;
    env?: NodeJS.ProcessEnv;
    clearinghouseSlug?: string;
  } = {},
): Promise<ResolvedBillingIdentity> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();
  const env = opts.env ?? process.env;
  const clearinghouseSlug = opts.clearinghouseSlug ?? "office_ally";

  // 1. Try the DB.
  const org = await loadOrganization(supabase);
  const ch = await loadClearinghouse(supabase, clearinghouseSlug);

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

  // 2. Fall back to env (legacy path).
  const envBilling = envBillingProvider(env);
  const envSubmitter = envSubmitter_(env);
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
    supabase?: SupabaseClient;
    env?: NodeJS.ProcessEnv;
    slug?: string;
  } = {},
): Promise<ResolvedClearinghouse> {
  const supabase = opts.supabase ?? getSupabaseServiceRoleClient();
  const env = opts.env ?? process.env;
  const slug = opts.slug ?? "office_ally";
  const row = await loadClearinghouse(supabase, slug);
  // Real-time config is independent of the SFTP path — compute it once
  // from (row, env) and surface it in every branch.
  const realtimeConfig = buildRealtimeConfig(row, env);
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
      usageIndicator: row.usage_indicator,
      submitter: {
        etin: row.etin,
        organizationName: row.submitter_organization_name ?? "PENNPAPS INC",
        contactName: row.contact_name ?? "BILLING",
        contactPhoneE164: row.contact_phone_e164 ?? "+10000000000",
      },
    };
  }
  // Env fallback for the SFTP path.
  if (
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
      usageIndicator: env.OFFICE_ALLY_USAGE_INDICATOR === "P" ? "P" : "T",
      submitter: envSubmitter_(env) ?? stubSubmitter(),
    };
  }
  return {
    source: "stub",
    row: null,
    config: null,
    realtimeConfig,
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

// ── Loaders ─────────────────────────────────────────────────────────

async function loadOrganization(
  supabase: SupabaseClient,
): Promise<OrgRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("dme_organization")
    .select(
      "id, singleton, legal_name, dba_name, tax_id, organizational_npi, taxonomy_code, medicare_ptan, physical_address_line1, physical_address_line2, physical_city, physical_state, physical_zip, mailing_address_line1, mailing_address_line2, mailing_city, mailing_state, mailing_zip, pay_to_address_line1, pay_to_address_line2, pay_to_city, pay_to_state, pay_to_zip, phone_e164, fax_e164, billing_email, general_email, support_email, support_phone_e164, support_hours_text, website_url, accreditation_body, accreditation_number, accreditation_expires_on, state_license_number, state_license_state, state_license_expires_on, liability_carrier, liability_policy_number, liability_expires_on, surety_bond_carrier, surety_bond_amount_cents, surety_bond_expires_on, authorized_signer_name, authorized_signer_title, authorized_signer_signature_object_key, notes, created_at, updated_at",
    )
    .eq("singleton", true)
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
  supabase: SupabaseClient,
  slug: string,
): Promise<ClearinghouseRow | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("clearinghouse_credentials")
    .select(
      "id, slug, display_name, usage_indicator, sftp_host, sftp_port, sftp_username, private_key_path, known_hosts_path, remote_inbox_dir, remote_outbound_dir, remote_archive_dir, etin, submitter_organization_name, contact_name, contact_phone_e164, is_active, last_polled_at, notes, realtime_enabled, realtime_url, realtime_username, realtime_sender_id, realtime_receiver_id, realtime_timeout_ms, realtime_password, created_at, updated_at",
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
