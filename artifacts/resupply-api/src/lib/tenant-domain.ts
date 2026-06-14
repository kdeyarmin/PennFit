// Tenant custom-domain helpers — normalization, the DNS TXT ownership
// challenge, and the operator-facing DNS instructions.
//
// A tenant binds ONE custom domain to their storefront. Proving they
// actually control that domain (before we route traffic to their tenant
// and add the host to the CORS allowlist) is a standard SaaS DNS-TXT
// challenge:
//
//   1. We mint a random token and persist it on the org row.
//   2. The tenant publishes a TXT record at a well-known name under their
//      domain whose value embeds the token.
//   3. They hit "Verify"; we resolve the TXT record and look for the
//      token. A match flips the domain to `verified`.
//
// Pointing the domain at the platform (the CNAME) and provisioning TLS in
// Railway/Cloudflare stays an OPERATOR step — see
// docs/runbooks/tenant-custom-domain.md. This module owns only the parts
// the app can do on its own.

import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";

/** DNS label the verification TXT record is published under. */
export const DOMAIN_VERIFY_TXT_HOST = "_pennfit-verify";

/** Prefix on the TXT value so the record is self-describing in a zone. */
export const DOMAIN_VERIFY_TXT_PREFIX = "pennfit-domain-verification=";

/**
 * Normalize operator input into a bare, lowercase DNS hostname, or null
 * when it can't be a routable custom domain.
 *
 * Strips an accidental scheme / path / port / trailing dot, lowercases,
 * and validates the shape (labels of a-z/0-9/-, at least one dot, no
 * leading/trailing hyphen). Rejects bare `localhost`, Ided addresses, and
 * the platform's own apex hosts so a tenant can't claim them.
 */
export function normalizeCustomDomain(raw: string): string | null {
  let value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  // Tolerate a pasted URL.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  }
  // Drop any stray path, query, port, or trailing dot.
  value = value.split("/")[0]!.split("?")[0]!.split(":")[0]!;
  if (value.endsWith(".")) value = value.slice(0, -1);
  value = value.replace(/^www\./, "");

  if (value.length === 0 || value.length > 253) return null;
  // Must be a dotted hostname (apex or sub), not an IP or single label.
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value)) return null;
  if (!value.includes(".")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null; // bare IPv4
  const labels = value.split(".");
  if (labels.some((l) => l.length === 0 || l.length > 63)) return null;
  if (labels.some((l) => l.startsWith("-") || l.endsWith("-"))) return null;

  // Don't let a tenant claim the platform's own hostnames.
  if (value === "localhost" || value.endsWith(".localhost")) return null;
  if (value.endsWith(".up.railway.app")) return null;

  return value;
}

/** Mint a fresh, URL-safe verification token (stored on the org row). */
export function generateDomainToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The full TXT value the tenant must publish for `token`. */
export function domainVerifyTxtValue(token: string): string {
  return `${DOMAIN_VERIFY_TXT_PREFIX}${token}`;
}

export interface DomainDnsInstructions {
  /** The host the storefront CNAME should point at (apex needs a flatten/ALIAS). */
  cnameTarget: string;
  /** TXT record name the tenant publishes for ownership proof. */
  txtName: string;
  /** Full TXT record value (prefix + token). */
  txtValue: string;
}

/**
 * Build the DNS records a tenant must publish, given their domain + token.
 * The CNAME target defaults to the platform's public host (so a tenant
 * subdomain like `shop.acme.com` flows through Railway/Cloudflare), and is
 * overridable with `PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET` for operators who
 * front the platform with a dedicated ingress hostname.
 */
export function buildDomainInstructions(
  domain: string,
  token: string,
): DomainDnsInstructions {
  const target =
    (process.env.PENNFIT_CUSTOM_DOMAIN_CNAME_TARGET ?? "").trim() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim() ||
    "pennfit.up.railway.app";
  return {
    cnameTarget: target,
    txtName: `${DOMAIN_VERIFY_TXT_HOST}.${domain}`,
    txtValue: domainVerifyTxtValue(token),
  };
}

/**
 * Resolve the verification TXT record for `domain` and report whether it
 * contains `token`. Fail-soft: any DNS error (NXDOMAIN, no record yet,
 * timeout) resolves to `false` — "not verified", never a thrown error —
 * so the admin "Verify" button always returns a clean yes/no.
 *
 * `resolver` is a test seam.
 */
export async function verifyDomainTxt(
  domain: string,
  token: string,
  resolver: (host: string) => Promise<string[][]> = resolveTxt,
): Promise<boolean> {
  const expected = domainVerifyTxtValue(token);
  try {
    const records = await resolver(`${DOMAIN_VERIFY_TXT_HOST}.${domain}`);
    // Each TXT record is an array of strings (long values are chunked);
    // join the chunks before comparing.
    return records.some((chunks) => chunks.join("").trim() === expected);
  } catch {
    return false;
  }
}
