// Coverage for the SSRF guard used by the webhook dispatcher and
// the inbound-referral status outbox. The synchronous validator
// rejects internal IP literals + obvious internal hostnames.
// The async validator catches DNS rebinding by resolving and
// checking the resulting addresses.

import { describe, expect, it } from "vitest";

import {
  SsrfError,
  assertSafeOutboundUrlSync,
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
    ["::ffff:127.0.0.1"], // v4-mapped loopback
    ["::ffff:10.0.0.1"], // v4-mapped private
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
