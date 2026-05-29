// Coverage for the SSRF guard used by the webhook dispatcher and
// the inbound-referral status outbox. The synchronous validator
// rejects internal IP literals + obvious internal hostnames.
// The async validator catches DNS rebinding by resolving and
// checking the resulting addresses.

import { describe, expect, it } from "vitest";

import {
  SsrfError,
  assertSafeOutboundUrlSync,
  fetchWithPinnedIp,
  isPrivateOrReservedIp,
} from "./safe-outbound";

describe("isPrivateOrReservedIp — IPv4", () => {
  it.each([
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["127.0.0.1"],
    ["127.255.255.254"],
    ["169.254.169.254"], // AWS / GCP metadata
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.168.0.1"],
    ["192.168.255.255"],
    ["100.64.0.1"], // CGNAT
    ["100.127.255.254"],
    ["0.0.0.0"],
    ["224.0.0.1"], // multicast
    ["240.0.0.0"],
    ["255.255.255.255"],
  ])("rejects %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["172.32.0.1"], // just outside 172.16/12
    ["100.63.0.1"], // just outside CGNAT
    ["100.128.0.1"], // just outside CGNAT
    ["169.253.255.255"], // just outside link-local
    ["192.169.0.0"], // just outside 192.168/16
  ])("accepts %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });

  it("treats malformed input as reserved (fail-closed)", () => {
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
    expect(isPrivateOrReservedIp("1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("999.0.0.1")).toBe(true);
  });
});

describe("isPrivateOrReservedIp — IPv6", () => {
  it.each([
    ["::1"], // loopback
    ["::"], // unspecified
    ["::ffff:127.0.0.1"], // v4-mapped loopback (dotted)
    ["::ffff:10.0.0.1"], // v4-mapped private (dotted)
    ["::ffff:7f00:1"], // v4-mapped loopback (hex two-group)
    ["::ffff:7f000001"], // v4-mapped loopback (hex one-group)
    ["::ffff:a00:1"], // v4-mapped 10.0.0.1 (hex two-group)
    ["::ffff:0:0"], // v4-mapped 0.0.0.0 (hex — previously bypassed)
    ["0:0:0:0:0:ffff:7f00:1"], // v4-mapped fully expanded
    ["fc00::1"], // unique-local
    ["fd00::1"], // unique-local
    ["fe80::1"], // link-local
    ["ff02::1"], // multicast
  ])("rejects %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    ["2001:4860:4860::8888"], // Google public DNS
    ["2606:4700:4700::1111"], // Cloudflare public DNS
  ])("accepts public %s", (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });
});

describe("assertSafeOutboundUrlSync", () => {
  it("rejects non-https", () => {
    expect(() => assertSafeOutboundUrlSync("http://example.com/x")).toThrow(
      SsrfError,
    );
  });

  it("rejects malformed URLs", () => {
    expect(() => assertSafeOutboundUrlSync("not a url")).toThrow(SsrfError);
  });

  it("rejects localhost", () => {
    expect(() => assertSafeOutboundUrlSync("https://localhost/foo")).toThrow(
      SsrfError,
    );
  });

  it("rejects .internal / .local", () => {
    expect(() =>
      assertSafeOutboundUrlSync("https://api.internal/foo"),
    ).toThrow(SsrfError);
    expect(() => assertSafeOutboundUrlSync("https://printer.local/foo")).toThrow(
      SsrfError,
    );
  });

  it("rejects AWS metadata IP literal", () => {
    expect(() =>
      assertSafeOutboundUrlSync("https://169.254.169.254/latest/meta-data/"),
    ).toThrow(SsrfError);
  });

  it("rejects 10.x and 192.168.x literals", () => {
    expect(() => assertSafeOutboundUrlSync("https://10.0.0.5/")).toThrow(
      SsrfError,
    );
    expect(() => assertSafeOutboundUrlSync("https://192.168.1.1/")).toThrow(
      SsrfError,
    );
  });

  it("accepts public-looking hostnames and IPs", () => {
    expect(() => assertSafeOutboundUrlSync("https://example.com/x")).not.toThrow();
    expect(() => assertSafeOutboundUrlSync("https://8.8.8.8/x")).not.toThrow();
  });

  it("returns the parsed URL", () => {
    const u = assertSafeOutboundUrlSync("https://example.com/foo?bar=1");
    expect(u.hostname).toBe("example.com");
    expect(u.pathname).toBe("/foo");
    expect(u.search).toBe("?bar=1");
  });
});

// ── fetchWithPinnedIp — new HttpAgent/HttpsAgent implementation ──────────────
// The PR replaced the undici-based dispatcher with node:http/https Agent
// to remove the undici peer-dependency. The new implementation:
//   - Rewrites the URL hostname to the pinned IP
//   - Sets the Host header to the original hostname
//   - Passes the agent option (not dispatcher)
//   - No longer validates host mismatch (removed defense-in-depth check)

describe("fetchWithPinnedIp", () => {
  // A fetch stub that records call args and returns a fixed 200 response.
  function mockFetch() {
    const calls: Array<{
      url: unknown;
      init: (RequestInit & { agent?: unknown; dispatcher?: unknown }) | undefined;
    }> = [];
    const fn = ((url: unknown, init?: RequestInit) => {
      calls.push({ url, init: init as never });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it("rewrites the URL hostname to the pinned IP (IPv4)", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(fn, "https://example.com/path?q=1", "93.184.216.34", "example.com");
    expect(calls).toHaveLength(1);
    // Must connect to the pinned IP, not the original hostname.
    const called = calls[0]!.url as string;
    expect(called).toContain("93.184.216.34");
    expect(called).toContain("/path");
    expect(called).toContain("?q=1");
  });

  it("wraps IPv6 pinned IP in brackets in the URL", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(fn, "https://example.com/", "2001:4860:4860::8888", "example.com");
    expect(calls).toHaveLength(1);
    const called = calls[0]!.url as string;
    expect(called).toContain("[2001:4860:4860::8888]");
  });

  it("sets the Host header to the original hostname", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(fn, "https://example.com/x", "93.184.216.34", "example.com");
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.get("Host")).toBe("example.com");
  });

  it("passes an agent option (not dispatcher)", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(fn, "https://example.com/", "93.184.216.34", "example.com");
    const init = calls[0]!.init as Record<string, unknown>;
    expect(init.agent).toBeDefined();
    expect(init.dispatcher).toBeUndefined();
  });

  it("preserves caller-supplied init options (method, body)", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(
      fn,
      "https://example.com/api",
      "93.184.216.34",
      "example.com",
      { method: "POST", body: "hello" },
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe("hello");
  });

  it("does not override a caller-supplied Host header", async () => {
    const { fn, calls } = mockFetch();
    await fetchWithPinnedIp(
      fn,
      "https://example.com/x",
      "93.184.216.34",
      "example.com",
      { headers: { Host: "custom.example.com" } },
    );
    const headers = calls[0]!.init?.headers as Headers;
    expect(headers.get("Host")).toBe("custom.example.com");
  });

  // Regression: the previous implementation refused when url host != originalHostname
  // (threw SsrfError("pinned_host_mismatch")). That check was removed in the PR.
  it("no longer throws when url host differs from originalHostname (check removed)", async () => {
    const { fn, calls } = mockFetch();
    // Should NOT throw — the host-mismatch guard was removed.
    await expect(
      fetchWithPinnedIp(fn, "https://example.com/", "93.184.216.34", "other.example.net"),
    ).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});
