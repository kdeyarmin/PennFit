// Read-at-call-time Office Ally credentials. Mirrors the AirView /
// Stripe pattern: missing env returns null, the adapter degrades to
// stub mode, the admin UI flags it as "not configured" — never crashes
// the boot sequence.
//
// Required env for live mode:
//   OFFICE_ALLY_USERNAME              — SFTP username (your OA submitter id)
//   OFFICE_ALLY_PRIVATE_KEY_PATH      — absolute path to the 0600 key file
//   OFFICE_ALLY_KNOWN_HOSTS_PATH      — absolute path to a known_hosts file
//                                       pinning sftp10.officeally.com
//   OFFICE_ALLY_ETIN                  — your submitter ETIN (assigned by OA)
//   OFFICE_ALLY_BILLING_NPI           — type-2 NPI for the DME entity
//   OFFICE_ALLY_BILLING_TAX_ID        — 9-digit EIN (no dashes)
//   OFFICE_ALLY_BILLING_ORG_NAME      — legal name as printed on the EIN
//   OFFICE_ALLY_BILLING_ADDRESS_LINE1
//   OFFICE_ALLY_BILLING_CITY
//   OFFICE_ALLY_BILLING_STATE         — 2-char USPS state
//   OFFICE_ALLY_BILLING_ZIP           — 5 or 9 digit zip (no dash)
//
// Optional:
//   OFFICE_ALLY_HOST                  — default sftp10.officeally.com
//   OFFICE_ALLY_PORT                  — default 22
//   OFFICE_ALLY_REMOTE_INBOX          — default `inbound`
//   OFFICE_ALLY_USAGE_INDICATOR       — `P` (production) or `T` (test). Default `T`.
//   OFFICE_ALLY_FILE_OUTBOX_DIR       — when stub mode is active, write
//                                       files here. Default <cwd>/outputs/office-ally/.
//   OFFICE_ALLY_STUB=1                — force stub mode even when creds present
//                                       (useful for staging / offline preview).
//   OFFICE_ALLY_CONTACT_NAME          — printed on PER segment (default 'BILLING')
//   OFFICE_ALLY_CONTACT_PHONE_E164    — printed on PER segment

import { resolve } from "node:path";

export interface OfficeAllyConfig {
  sftp: {
    host: string;
    port: number;
    username: string;
    privateKeyPath: string;
    knownHostsPath: string;
    remoteInboxDir: string;
  };
  submitter: {
    etin: string;
    organizationName: string;
    contactName: string;
    contactPhoneE164: string;
  };
  billingProvider: {
    organizationName: string;
    npi: string;
    taxId: string;
    address: {
      line1: string;
      city: string;
      state: string;
      zip: string;
    };
  };
  /** Production = `P`, test = `T`. */
  usageIndicator: "P" | "T";
}

export function readOfficeAllyConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): OfficeAllyConfig | null {
  if (env.OFFICE_ALLY_STUB === "1") return null;
  const username = env.OFFICE_ALLY_USERNAME;
  const privateKeyPath = env.OFFICE_ALLY_PRIVATE_KEY_PATH;
  const knownHostsPath = env.OFFICE_ALLY_KNOWN_HOSTS_PATH;
  const etin = env.OFFICE_ALLY_ETIN;
  const npi = env.OFFICE_ALLY_BILLING_NPI;
  const taxId = env.OFFICE_ALLY_BILLING_TAX_ID;
  const orgName = env.OFFICE_ALLY_BILLING_ORG_NAME;
  const line1 = env.OFFICE_ALLY_BILLING_ADDRESS_LINE1;
  const city = env.OFFICE_ALLY_BILLING_CITY;
  const state = env.OFFICE_ALLY_BILLING_STATE;
  const zip = env.OFFICE_ALLY_BILLING_ZIP;
  if (
    !username ||
    !privateKeyPath ||
    !knownHostsPath ||
    !etin ||
    !npi ||
    !taxId ||
    !orgName ||
    !line1 ||
    !city ||
    !state ||
    !zip
  ) {
    return null;
  }
  return {
    sftp: {
      host: env.OFFICE_ALLY_HOST?.trim() || "sftp10.officeally.com",
      port: parsePort(env.OFFICE_ALLY_PORT),
      username,
      privateKeyPath: resolve(privateKeyPath),
      knownHostsPath: resolve(knownHostsPath),
      remoteInboxDir: env.OFFICE_ALLY_REMOTE_INBOX?.trim() || "inbound",
    },
    submitter: {
      etin,
      organizationName: orgName,
      contactName: env.OFFICE_ALLY_CONTACT_NAME?.trim() || "BILLING",
      contactPhoneE164:
        env.OFFICE_ALLY_CONTACT_PHONE_E164?.trim() || "+10000000000",
    },
    billingProvider: {
      organizationName: orgName,
      npi,
      taxId,
      address: { line1, city, state, zip },
    },
    usageIndicator: env.OFFICE_ALLY_USAGE_INDICATOR === "P" ? "P" : "T",
  };
}

export function isOfficeAllyStubMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.OFFICE_ALLY_STUB === "1";
}

// Real-time eligibility (270/271) over Office Ally's EDI REST API
// (edi.officeally.io). A SEPARATE channel from the SFTP batch transport
// above: SFTP carries 837 claims + the async 271 (picked up by the inbound
// poll), whereas the real-time service POSTs the raw 270 and returns the
// 271 inline in one request. Fully optional and fail-soft — when its env
// is absent, `verifyEligibility` falls back to the SFTP submit-and-poll
// path. The endpoint + key are NOT the SFTP key; they are the real-time
// REST credentials Office Ally issues separately.
//
//   OFFICE_ALLY_REALTIME_URL          — the /v2/eligibility-benefits/x12
//                                       endpoint URL
//   OFFICE_ALLY_REALTIME_API_KEY      — API key, sent verbatim in the
//                                       Authorization header (legacy alias:
//                                       OFFICE_ALLY_REALTIME_PASSWORD)
//
// Optional:
//   OFFICE_ALLY_REALTIME_TIMEOUT_MS   — per-request timeout (default 30000)
export interface OfficeAllyRealtimeConfig {
  /** Full real-time eligibility endpoint URL (the /x12 path). */
  url: string;
  /** API key, sent verbatim in the Authorization header. */
  apiKey: string;
  timeoutMs: number;
}

export function readOfficeAllyRealtimeConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): OfficeAllyRealtimeConfig | null {
  // Stub mode means "don't transmit anywhere" — honor it here too so
  // staging/offline preview never reaches out over the real-time path.
  if (env.OFFICE_ALLY_STUB === "1") return null;
  const url = env.OFFICE_ALLY_REALTIME_URL?.trim();
  const apiKey =
    env.OFFICE_ALLY_REALTIME_API_KEY?.trim() ||
    env.OFFICE_ALLY_REALTIME_PASSWORD?.trim();
  // All-or-null, mirroring readOfficeAllyConfigOrNull: a partial config
  // degrades to the SFTP path rather than half-attempting real-time.
  if (!url || !apiKey) return null;
  // The 270 we POST here is PHI in cleartext-on-the-wire and the URL is
  // operator-supplied, so an https + host-allowlist check is mandatory:
  // it stops a misconfigured (http://) endpoint from sending a 270 in
  // the clear, and stops a malicious/typo'd host from turning this into
  // an SSRF exfiltration sink. Fail-soft per the reader contract — a URL
  // that doesn't validate returns null (degrade to the SFTP path), never
  // throws at boot.
  if (!isAllowedOfficeAllyEdiUrl(url)) return null;
  return {
    url,
    apiKey,
    timeoutMs: parseTimeoutMs(env.OFFICE_ALLY_REALTIME_TIMEOUT_MS),
  };
}

/**
 * True iff `raw` is a well-formed HTTPS URL whose host is Office Ally's
 * EDI domain (`officeally.io` or any `*.officeally.io` subdomain — the
 * real-time endpoint lives at `edi.officeally.io`). Anything else
 * (http, a non-OA host, a malformed URL) is rejected so the 270 PHI
 * never leaves over cleartext or to an attacker-chosen host. Pure /
 * never throws.
 */
export function isAllowedOfficeAllyEdiUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "officeally.io" || host.endsWith(".officeally.io");
}

// Insurance discovery over Office Ally's EDI REST API. A SEPARATE endpoint
// from real-time eligibility (the "search every payer for this person"
// service vs. "is this one coverage active"), but the SAME issued EDI API
// account — so it reuses the real-time Authorization key and only needs its
// own endpoint URL. Fully optional and fail-soft: when its env is absent,
// `createInsuranceDiscoveryTransport(null)` degrades to a no-op that reports
// `unavailable` and the discovery route returns a clean "not configured"
// reason instead of throwing.
//
//   OFFICE_ALLY_DISCOVERY_URL          — the insurance-discovery endpoint URL
//   OFFICE_ALLY_REALTIME_API_KEY       — API key, sent verbatim in the
//                                        Authorization header (legacy alias:
//                                        OFFICE_ALLY_REALTIME_PASSWORD)
//
// Optional:
//   OFFICE_ALLY_DISCOVERY_TIMEOUT_MS   — per-request timeout (default 30000)
export interface OfficeAllyDiscoveryConfig {
  /** Full insurance-discovery endpoint URL. */
  url: string;
  /** API key, sent verbatim in the Authorization header (the SAME OA EDI
   *  account/key as real-time eligibility). */
  apiKey: string;
  timeoutMs: number;
}

export function readOfficeAllyDiscoveryConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): OfficeAllyDiscoveryConfig | null {
  // Stub mode means "don't transmit anywhere" — honor it here too.
  if (env.OFFICE_ALLY_STUB === "1") return null;
  const url = env.OFFICE_ALLY_DISCOVERY_URL?.trim();
  const apiKey =
    env.OFFICE_ALLY_REALTIME_API_KEY?.trim() ||
    env.OFFICE_ALLY_REALTIME_PASSWORD?.trim();
  // All-or-null, mirroring the real-time reader: a partial config reports
  // unavailable rather than half-attempting a discovery search.
  if (!url || !apiKey) return null;
  // The request carries demographics (PHI) and the URL is operator-supplied,
  // so the same https + Office-Ally-host allowlist the real-time reader
  // applies is mandatory here — it stops a cleartext (http://) endpoint and
  // an SSRF-to-attacker-host typo. Fail-soft: an invalid URL returns null.
  if (!isAllowedOfficeAllyEdiUrl(url)) return null;
  return {
    url,
    apiKey,
    timeoutMs: parseTimeoutMs(env.OFFICE_ALLY_DISCOVERY_TIMEOUT_MS),
  };
}

export function resolveOutboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OFFICE_ALLY_FILE_OUTBOX_DIR?.trim();
  return raw ? resolve(raw) : resolve(process.cwd(), "outputs", "office-ally");
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 22;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return 22;
  return n;
}

const DEFAULT_REALTIME_TIMEOUT_MS = 30_000;

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_REALTIME_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_REALTIME_TIMEOUT_MS;
  return n;
}
