// Trusted reverse-proxy resolution for Express's `trust proxy` setting
// (app-review 2026-06-10, P1-5).
//
// The problem: the custom domain (pennpaps.com) is fronted by
// Cloudflare, which adds a SECOND proxy hop in front of Railway's
// edge. With the historical `trust proxy = 1`, `req.ip` for all
// custom-domain traffic resolved to the Cloudflare colo IP — every
// IP-keyed rate limiter (sign-in, forgot/reset, orders, chat, …)
// bucketed all Cloudflare-routed visitors into a handful of edge IPs,
// and audit rows recorded Cloudflare addresses. Traffic on
// *.up.railway.app (one hop) keyed correctly, which masked the bug.
//
// The fix is deliberately FAIL-SAFE so it does not depend on live
// confirmation of Railway's exact X-Forwarded-For behavior (the
// reason the audit deferred this): the trust function trusts
//   * hop 0 unconditionally — byte-for-byte the old `trust proxy = 1`
//     behavior, covering Railway's edge whatever address family or
//     range it uses, and
//   * any address inside Cloudflare's published ranges, at any hop.
//
// Outcomes, by path:
//   * Cloudflare → Railway (custom domain): XFF is
//     [client, cf-edge]; the walk trusts the socket (hop 0) and the
//     Cloudflare edge entry, stops at the client → req.ip = client. ✓
//   * Direct → Railway (*.up.railway.app): XFF is [client]; the walk
//     trusts the socket and stops at the client → req.ip = client —
//     identical to today. ✓
//   * Spoofed XFF, direct: attacker sends XFF: <fake>; Railway appends
//     the attacker's real address → [fake, attacker]; attacker's
//     address is not a Cloudflare range, so the walk stops there →
//     req.ip = attacker. Spoof fails. ✓
//   * Spoofed XFF via Cloudflare: Cloudflare appends the attacker's
//     real address itself → [fake, attacker, cf-edge]; the walk stops
//     at the attacker entry → req.ip = attacker. Spoof fails. ✓
//
// Every case is equal-or-better than `trust proxy = 1`; none is
// worse, so the change is safe to ship without a runtime probe.
//
// The Cloudflare ranges below are the published lists from
// https://www.cloudflare.com/ips/ (stable for years; last verified
// 2026-06-12). If Cloudflare ever adds a range before this list is
// updated, traffic via the new range degrades to the OLD behavior
// (keyed on the edge IP) — never to anything worse. Operators can
// bridge the gap without a deploy via RESUPPLY_TRUSTED_PROXY_CIDRS
// (comma-separated CIDRs, appended to the built-in list).

import { BlockList, isIPv4 } from "node:net";

import { logger } from "./logger";

// https://www.cloudflare.com/ips-v4/
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

// https://www.cloudflare.com/ips-v6/
const CLOUDFLARE_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

function parseCidr(cidr: string): { net: string; prefix: number } | null {
  const slash = cidr.lastIndexOf("/");
  if (slash === -1) return null;
  const net = cidr.slice(0, slash).trim();
  const prefix = Number.parseInt(cidr.slice(slash + 1), 10);
  if (!net || !Number.isFinite(prefix) || prefix < 0) return null;
  return { net, prefix };
}

function buildBlockList(extraCidrsRaw: string | undefined): BlockList {
  const list = new BlockList();
  for (const cidr of CLOUDFLARE_IPV4_CIDRS) {
    const parsed = parseCidr(cidr);
    if (parsed) list.addSubnet(parsed.net, parsed.prefix, "ipv4");
  }
  for (const cidr of CLOUDFLARE_IPV6_CIDRS) {
    const parsed = parseCidr(cidr);
    if (parsed) list.addSubnet(parsed.net, parsed.prefix, "ipv6");
  }
  // Operator escape hatch: extend the trusted set without a deploy
  // (e.g. Cloudflare publishes a new range). Invalid entries are
  // logged and skipped — a typo must never take the boot down.
  //
  // The log line identifies the bad entry by POSITION, never by
  // content: the value comes from process.env, and an env-derived
  // string must not reach the world-readable log stream (someone
  // could paste a secret into the wrong variable; CodeQL
  // js/clear-text-logging flags exactly this).
  const extras = (extraCidrsRaw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  extras.forEach((cidr, index) => {
    const parsed = parseCidr(cidr);
    if (!parsed) {
      logger.warn(
        { event: "trusted_proxy_cidr_invalid", entryIndex: index },
        "trusted-proxies: ignoring malformed RESUPPLY_TRUSTED_PROXY_CIDRS entry",
      );
      return;
    }
    try {
      list.addSubnet(
        parsed.net,
        parsed.prefix,
        isIPv4(parsed.net) ? "ipv4" : "ipv6",
      );
    } catch {
      logger.warn(
        { event: "trusted_proxy_cidr_invalid", entryIndex: index },
        "trusted-proxies: ignoring malformed RESUPPLY_TRUSTED_PROXY_CIDRS entry",
      );
    }
  });
  return list;
}

/** Strip the IPv4-mapped-IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`)
 *  so a mapped address matches the IPv4 subnet list. */
function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.startsWith("::ffff:") && isIPv4(addr.slice(7))) {
    return addr.slice(7);
  }
  return addr;
}

/**
 * Build the Express `trust proxy` predicate: trust hop 0 (the direct
 * peer — Railway's edge, exactly the old `trust proxy = 1`) plus any
 * address inside Cloudflare's published ranges at any hop. Reads
 * RESUPPLY_TRUSTED_PROXY_CIDRS once at construction (boot).
 */
export function createTrustProxyFn(): (addr: string, i: number) => boolean {
  const list = buildBlockList(process.env.RESUPPLY_TRUSTED_PROXY_CIDRS);
  return (addr: string, i: number): boolean => {
    if (i === 0) return true;
    if (typeof addr !== "string" || addr.length === 0) return false;
    const normalized = normalizeAddress(addr);
    try {
      return list.check(normalized, isIPv4(normalized) ? "ipv4" : "ipv6");
    } catch {
      // Unparseable forwarded entry — never trust it.
      return false;
    }
  };
}
