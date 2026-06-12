// Route tests for /admin/diagnostics/proxy-chain — gating + the echo
// contract under different trust-proxy settings and header shapes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import proxyChainRouter from "./proxy-chain";

function makeApp(trustProxy?: number | boolean): Express {
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.use(proxyChainRouter);
  return app;
}

function asSuperAdmin() {
  mockAdmin.current = {
    userId: "u1",
    email: "boss@pennpaps.com",
    role: "admin",
    granularRole: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
});

describe("auth gating", () => {
  it("401 when not signed in", async () => {
    const res = await request(makeApp()).get(
      "/admin/diagnostics/proxy-chain",
    );
    expect(res.status).toBe(401);
  });

  it("403 for a non-super-admin (CSR)", async () => {
    mockAdmin.current = {
      userId: "u2",
      email: "csr@pennpaps.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp()).get(
      "/admin/diagnostics/proxy-chain",
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "permission_denied",
      requiredPermission: "system.config.manage",
    });
  });
});

describe("echo contract", () => {
  beforeEach(asSuperAdmin);

  it("returns the raw forwarding headers and Express's resolution under trust proxy = 1", async () => {
    const res = await request(makeApp(1))
      .get("/admin/diagnostics/proxy-chain")
      .set("X-Forwarded-For", "203.0.113.7, 198.51.100.2")
      .set("CF-Connecting-IP", "203.0.113.7")
      .set("CF-Ray", "8abc123-EWR");
    expect(res.status).toBe(200);
    expect(res.body.headers).toMatchObject({
      "x-forwarded-for": "203.0.113.7, 198.51.100.2",
      "cf-connecting-ip": "203.0.113.7",
      "cf-ray": "8abc123-EWR",
      // Absent headers come back as explicit nulls, not undefined.
      "true-client-ip": null,
    });
    // With ONE trusted hop, req.ip resolves to the LAST entry in XFF —
    // the immediate proxy's claim — which is exactly the P1-5 bug shape
    // behind a two-hop Cloudflare → Railway chain.
    expect(res.body.expressResolution.trustProxy).toBe(1);
    expect(res.body.expressResolution.ip).toBe("198.51.100.2");
    expect(res.body.expressResolution.ips).toEqual(["198.51.100.2"]);
  });

  it("resolves the originating client under trust proxy = 2 (two-hop chain)", async () => {
    const res = await request(makeApp(2))
      .get("/admin/diagnostics/proxy-chain")
      .set("X-Forwarded-For", "203.0.113.7, 198.51.100.2");
    expect(res.status).toBe(200);
    expect(res.body.expressResolution.ip).toBe("203.0.113.7");
    expect(res.body.expressResolution.ips).toEqual([
      "203.0.113.7",
      "198.51.100.2",
    ]);
  });

  it("reports the socket peer and host with no forwarding headers at all", async () => {
    const res = await request(makeApp()).get(
      "/admin/diagnostics/proxy-chain",
    );
    expect(res.status).toBe(200);
    expect(res.body.host).toMatch(/127\.0\.0\.1/);
    expect(res.body.socket.remoteAddress).toBeTruthy();
    expect(res.body.headers["x-forwarded-for"]).toBeNull();
    expect(res.body.expressResolution.ips).toEqual([]);
  });
});
