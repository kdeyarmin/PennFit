// Outbound-URL safety check — refuses URLs that would hit internal /
// cloud-metadata infrastructure.
//
// Used by the webhook dispatcher (worker/jobs/webhook-dispatcher.ts)
// and the inbound-referral status outbox (worker/jobs/
// inbound-referral-status-outbound.ts) so an admin-controlled
// callback URL cannot be turned into an SSRF probe against the
// Replit / Supabase internal network or the AWS metadata endpoint
// at 169.254.169.254.
//
// Two layers of defence:
//   1. `assertSafeOutboundUrlSync(url)` — synchronous, runs at
//      validate-time (route accept of a new subscription) AND at
//      dispatch-time. Refuses unsupported schemes and IP literals
//      in private / loopback / link-local / metadata ranges.
//   2. `assertSafeOutboundHost(host)` — async, resolves DNS and
//      refuses if ANY resolved address is private/loopback/link-
//      local. Defends against DNS rebinding where a hostname
//      passes static checks but resolves to 127.0.0.1 / 10.x at
//      dispatch time.
//
// Both throw `SsrfError` on rejection; callers translate that to a
// 400 (validate-time) or "exhausted" delivery (dispatch-time) and
// skip the fetch.

import { lookup as dnsLookup } from "node:dns/promises";

export class SsrfError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`outbound URL rejected: ${reason}`);
    this.name = "SsrfError";
    this.reason = reason;
  }
}

/**
 * Synchronous URL-shape check. Pure: no network, safe to call from
 * Zod refines and route validators.
 *
 * Returns the parsed URL on success so the caller doesn't have to
 * re-parse. Throws SsrfError otherwise.
 */
export function assertSafeOutboundUrlSync(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError("malformed_url");
  }
  if (parsed.protocol !== "https:") {
    throw new SsrfError("not_https");
  }
  // Hostnames in URL may be bracketed for IPv6 — `URL.hostname`
  // strips the brackets, leaving the bare address.
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new SsrfError("missing_host");
  }
  // Common literal-hostname shortcuts for internal infra.
  if (
    host === "localhost" ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  ) {
    throw new SsrfError("internal_hostname");
  }
  // IP literals — block private / loopback / link-local /
  // metadata. A non-literal hostname falls through to the DNS
  // check at dispatch time.
  if (looksLikeIpLiteral(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new SsrfError("ip_literal_in_reserved_range");
    }
  }
  return parsed;
}

/**
 * DNS-aware check. Resolves the host and rejects if any resolved
 * address is in a private / reserved range. Run at dispatch time —
 * never trust a value that passed `assertSafeOutboundUrlSync`
 * alone, because DNS rebinding can flip a public-looking name
 * to 127.0.0.1 between validate and fetch.
 */
export async function assertSafeOutboundHost(host: string): Promise<void> {
  const lower = host.toLowerCase();
  // Skip DNS if the host is an IP literal — we already evaluated it
  // synchronously and accepted it (a public IP literal is OK).
  if (looksLikeIpLiteral(lower)) {
    if (isPrivateOrReservedIp(lower)) {
      throw new SsrfError("ip_literal_in_reserved_range");
    }
    return;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(lower, { all: true });
  } catch {
    throw new SsrfError("dns_resolution_failed");
  }
  for (const a of addresses) {
    if (isPrivateOrReservedIp(a.address)) {
      throw new SsrfError("resolved_to_reserved_ip");
    }
  }
}

function looksLikeIpLiteral(host: string): boolean {
  // IPv4: only digits and dots.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6: contains a colon (URL.hostname strips the brackets).
  if (host.includes(":")) return true;
  return false;
}

/**
 * True for any IP in a range we refuse to dispatch to: RFC1918
 * private, loopback, link-local (incl. cloud metadata at
 * 169.254.169.254), CGNAT, multicast, broadcast, IPv4-mapped
 * IPv6, IPv6 loopback / link-local / unique-local.
 *
 * Conservative: any unparseable input is treated as "reserved"
 * (refused) — fail closed.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  if (ip.includes(":")) {
    return isReservedIpv6(ip);
  }
  return isReservedIpv4(ip);
}

function isReservedIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  // 0.0.0.0/8 — "this network".
  if (a === 0) return true;
  // 10.0.0.0/8.
  if (a === 10) return true;
  // 100.64.0.0/10 — CGNAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 — loopback.
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local + AWS / GCP metadata.
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12.
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 — IETF protocol.
  if (a === 192 && b === 0 && nums[2] === 0) return true;
  // 192.0.2.0/24 — TEST-NET-1.
  if (a === 192 && b === 0 && nums[2] === 2) return true;
  // 192.168.0.0/16.
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 — benchmarking.
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 — TEST-NET-2.
  if (a === 198 && b === 51 && nums[2] === 100) return true;
  // 203.0.113.0/24 — TEST-NET-3.
  if (a === 203 && b === 0 && nums[2] === 113) return true;
  // 224.0.0.0/4 — multicast.
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 — reserved.
  if (a >= 240) return true;
  return false;
}

function isReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // ::1 — loopback.
  if (lower === "::1") return true;
  // :: — unspecified.
  if (lower === "::") return true;
  // ::ffff:a.b.c.d — IPv4-mapped. Strip and recurse on the v4 half.
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    return isReservedIpv4(v4MappedMatch[1]);
  }
  // fc00::/7 — unique-local.
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 — link-local.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;
  // ff00::/8 — multicast.
  if (lower.startsWith("ff")) return true;
  return false;
}
