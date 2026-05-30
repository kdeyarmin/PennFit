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
