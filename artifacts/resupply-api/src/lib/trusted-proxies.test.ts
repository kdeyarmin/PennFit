import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createTrustProxyFn } from "./trusted-proxies";

const CF_V4 = "103.21.244.7";
const CF_V6 = "2606:4700::1234";
const PUBLIC = "8.8.8.8";
const CLIENT = "9.9.9.9";

afterEach(() => {
  delete process.env.RESUPPLY_TRUSTED_PROXY_CIDRS;
});

describe("createTrustProxyFn — predicate", () => {
  const trust = createTrustProxyFn();

  it("trusts hop 0 unconditionally", () => {
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

  it("direct Railway traffic resolves the single forwarded hop", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", CLIENT);
    expect(res.body.ip).toBe(CLIENT);
  });

  it("Cloudflare-routed traffic resolves the real client", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `${CLIENT}, ${CF_V4}`);
    expect(res.body.ip).toBe(CLIENT);
  });

  it("spoofed direct-path XFF resolves the attacker", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `1.2.3.4, ${PUBLIC}`);
    expect(res.body.ip).toBe(PUBLIC);
  });

  it("spoofed Cloudflare-path XFF resolves the attacker", async () => {
    const res = await request(makeApp())
      .get("/ip")
      .set("X-Forwarded-For", `1.2.3.4, ${PUBLIC}, ${CF_V4}`);
    expect(res.body.ip).toBe(PUBLIC);
  });
});
