// Outbound-URL safety check — refuses URLs that would hit internal /
// cloud-metadata infrastructure.
//
// Used by the webhook dispatcher (worker/jobs/webhook-dispatcher.ts)
// and the inbound-referral status outbox (worker/jobs/
// inbound-referral-status-outbound.ts) so an admin-controlled
// callback URL cannot be turned into an SSRF probe against the
// Railway / Supabase internal network or the cloud metadata
// endpoint at 169.254.169.254.
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
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { BlockList, isIP } from "node:net";

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
 *
 * Returns the first safe resolved IP address so callers can pin
 * their HTTP request to this address and prevent TOCTOU DNS rebinding.
 */
export async function assertSafeOutboundHost(host: string): Promise<string> {
  const lower = host.toLowerCase();
  // Skip DNS if the host is an IP literal — we already evaluated it
  // synchronously and accepted it (a public IP literal is OK).
  if (looksLikeIpLiteral(lower)) {
    if (isPrivateOrReservedIp(lower)) {
      throw new SsrfError("ip_literal_in_reserved_range");
    }
    return lower;
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
  // Return the first safe address for pinned connection
  if (addresses.length === 0) {
    throw new SsrfError("dns_no_addresses");
  }
  return addresses[0].address;
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

/**
 * IPv6 reserved-range check built on `net.BlockList`. The block list
 * canonicalises every IPv6 spelling — `::ffff:127.0.0.1`,
 * `::ffff:7f00:1`, `::ffff:0:0:7f00:1`, and the fully expanded
 * `0:0:0:0:0:ffff:7f00:1` all hit the same internal address — so we
 * cannot accidentally bypass the loopback / unique-local / link-local
 * filters by spelling the same address differently. The prior
 * hand-rolled hex parser had a hole on `::ffff:0:0`, and didn't
 * recognise mappings with 3+ hex groups at all.
 */
const RESERVED_V6 = (() => {
  const bl = new BlockList();
  bl.addAddress("::", "ipv6"); // unspecified
  bl.addAddress("::1", "ipv6"); // loopback
  bl.addSubnet("fc00::", 7, "ipv6"); // unique-local
  bl.addSubnet("fe80::", 10, "ipv6"); // link-local
  bl.addSubnet("ff00::", 8, "ipv6"); // multicast
  bl.addSubnet("::ffff:0.0.0.0", 96, "ipv6"); // IPv4-mapped — recurse on v4 portion below
  return bl;
})();

function isReservedIpv6(ip: string): boolean {
  if (isIP(ip) !== 6) return true; // unparseable → fail-closed
  if (!RESERVED_V6.check(ip, "ipv6")) return false;
  // IPv4-mapped is the only "reserved" range we don't refuse outright —
  // 8.8.8.8 mapped to v6 is still a public address. Recurse on the v4
  // half to apply the v4 reserved-range table.
  const lower = ip.toLowerCase();
  const dottedMatch = lower.match(
    /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (dottedMatch) {
    return isReservedIpv4(dottedMatch[1]);
  }
  const hexMatch = lower.match(/::ffff:([0-9a-f:]+)$/);
  if (hexMatch) {
    const groups = hexMatch[1].split(":").filter((g) => g.length > 0);
    // The v4-mapped tail is at most 32 bits, i.e. one or two 16-bit
    // hex groups. Anything else is malformed — fail-closed.
    if (groups.length > 2) return true;
    let ipv4Num: number;
    if (groups.length === 1) {
      const parsed = Number.parseInt(groups[0], 16);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0xffffffff) {
        return true;
      }
      ipv4Num = parsed;
    } else {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (
        !Number.isFinite(high) || !Number.isFinite(low) ||
        high < 0 || high > 0xffff || low < 0 || low > 0xffff
      ) {
        return true;
      }
      ipv4Num = (high << 16) | low;
    }
    const a = (ipv4Num >>> 24) & 0xff;
    const b = (ipv4Num >>> 16) & 0xff;
    const c = (ipv4Num >>> 8) & 0xff;
    const d = ipv4Num & 0xff;
    return isReservedIpv4(`${a}.${b}.${c}.${d}`);
  }
  // BlockList matched but we couldn't parse out the v4 tail — the
  // address is inside ::ffff::/96 but in a form we don't recognise.
  // Fail-closed.
  return true;
}

/**
 * Create a fetch request that connects to a pre-resolved IP address
 * to prevent TOCTOU DNS rebinding. The original hostname is preserved
 * in the Host header and URL for TLS SNI validation.
 *
 * Usage:
 *   const safeIp = await assertSafeOutboundHost(parsedUrl.hostname);
 *   const response = await fetchWithPinnedIp(fetch, url, safeIp, parsedUrl.hostname, options);
 */
export function fetchWithPinnedIp(
  fetchImpl: typeof fetch,
  url: string,
  pinnedIp: string,
  originalHostname: string,
  init?: RequestInit,
): Promise<Response> {
  // Create a custom agent that forces connection to the pinned IP
  // while preserving the original hostname for TLS SNI and Host header
  const parsedUrl = new URL(url);
  const isIpv6 = pinnedIp.includes(":");
  const host = isIpv6 ? `[${pinnedIp}]` : pinnedIp;

  // Replace hostname in URL with the pinned IP (wrapped in brackets if IPv6)
  const pinnedUrl = new URL(url);
  pinnedUrl.hostname = host;

  // For Node.js fetch (undici), we use a custom dispatcher/agent
  // that overrides the lookup to return our pinned IP
  const agent = parsedUrl.protocol === "https:"
    ? new HttpsAgent({
        lookup: (_hostname, _options, callback) => {
          // Always return the pinned IP regardless of hostname
          callback(null, pinnedIp, isIpv6 ? 6 : 4);
        },
      })
    : new HttpAgent({
        lookup: (_hostname, _options, callback) => {
          callback(null, pinnedIp, isIpv6 ? 6 : 4);
        },
      });

  // Ensure Host header uses original hostname for TLS SNI
  const headers = new Headers(init?.headers);
  if (!headers.has("Host")) {
    headers.set("Host", originalHostname);
  }

  return fetchImpl(pinnedUrl.toString(), {
    ...init,
    headers,
    // @ts-expect-error - Node.js fetch supports agent option (undici)
    agent,
  });
}
