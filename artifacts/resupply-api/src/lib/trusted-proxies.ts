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

function normalizeAddress(addr: string): string {
  const lower = addr.toLowerCase();
  if (lower.startsWith("::ffff:") && isIPv4(addr.slice(7))) {
    return addr.slice(7);
  }
  return addr;
}

export function createTrustProxyFn(): (addr: string, i: number) => boolean {
  const list = buildBlockList(process.env.RESUPPLY_TRUSTED_PROXY_CIDRS);
  return (addr: string, i: number): boolean => {
    if (i === 0) return true;
    if (typeof addr !== "string" || addr.length === 0) return false;
    const normalized = normalizeAddress(addr);
    try {
      return list.check(normalized, isIPv4(normalized) ? "ipv4" : "ipv6");
    } catch {
      return false;
    }
  };
}
