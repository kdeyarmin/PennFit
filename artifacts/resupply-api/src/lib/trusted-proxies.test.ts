// Regression tests for the trust-proxy predicate (app-review
// 2026-06-10, P1-5). The safety contract: every path must resolve
// req.ip equal-or-better than the historical `trust proxy = 1` —
// Cloudflare-routed traffic resolves to the real client, direct
// Railway traffic is unchanged, and X-Forwarded-For spoofing fails on
// both paths.

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createTrustProxyFn } from "./trusted-proxies";

// Addresses inside Cloudflare's published ranges (one v4, one v6).
const CF_V4 = "103.21.244.7";
const CF_V6 = "2606:4700::1234";
// A public address that is NOT a Cloudflare range.
const PUBLIC = "8.8.8.8";
const CLIENT = "9.9.9.9";

afterEach(() => {
  delete process.env.RESUPPLY_TRUSTED_PROXY_CIDRS;
});

describe("createTrustProxyFn — predicate", () => {
  const trust = createTrustProxyFn();

  it("trusts hop 0 unconditionally (the old trust-proxy=1 behavior)", () => {
    expect(trust(PUBLIC, 0)).toBe(true);
    expect(trust("garbage", 0)).toBe(true);
  });

  it("trusts Cloudflare IPv4 and IPv6 ranges at later hops", () => {
    expect(trust(CF_V4, 1)).toBe(true);
    expect(trust(CF_V6, 1)).toBe(true);
    expect(trust(`::ffff:${CF_V4}`, 1)).toBe(true);
  });

  it("does not trust non-Cloudflare addresses past hop 0", () => {
    expect(trust(PUBLIC, 1)).toBe(false);
    expect(trust(CLIENT, 2)).toBe(false);
    expect(trust("not-an-ip", 1)).toBe(false);
    expect(trust("", 1)).toBe(false);
  });

  it("honors RESUPPLY_TRUSTED_PROXY_CIDRS extras and skips malformed entries", () => {
    process.env.RESUPPLY_TRUSTED_PROXY_CIDRS =
      "203.0.113.0/24, bogus, 2001:db8::/32";
    const extended = createTrustProxyFn();
    expect(extended("203.0.113.9", 1)).toBe(true);
    expect(extended("2001:db8::5", 1)).toBe(true);
    expect(extended(PUBLIC, 1)).toBe(false);
  });
});

describe("createTrustProxyFn — req.ip resolution through Express", () => {
  function makeApp() {
    const app = express();
    app.set("trust proxy", createTrustProxyFn());
    app.get("/ip", (req, res) => {
      res.json({ ip: req.ip });
    });
    return app;
  }

  // Supertest connects over loopback, so the socket peer (hop 0) is
  // 127.0.0.1 — standing in for Railway's edge, trusted
  // unconditionally. The X-Forwarded-For header is then exactly what
  // Railway would have received and forwarded.

  it("direct Railway traffic: resolves the single forwarded hop (unchanged)", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", CLIENT);
    expect(res.body.ip).toBe(CLIENT);
  });

  it("Cloudflare-routed traffic: walks past the Cloudflare edge to the real client", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `${CLIENT}, ${CF_V4}`);
    expect(res.body.ip).toBe(CLIENT);
  });

  it("spoofed XFF on the direct path: resolves the attacker, not the spoof", async () => {
    // Attacker sends XFF: <fake>; Railway appends the attacker's real
    // address — the chain Express sees is [fake, attacker].
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `1.2.3.4, ${PUBLIC}`);
    expect(res.body.ip).toBe(PUBLIC);
  });

  it("spoofed XFF via Cloudflare: resolves the attacker, not the spoof", async () => {
    // Cloudflare appends the attacker's real address before its own
    // edge entry — the chain is [fake, attacker, cf-edge].
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `1.2.3.4, ${PUBLIC}, ${CF_V4}`);
    expect(res.body.ip).toBe(PUBLIC);
  });
});
