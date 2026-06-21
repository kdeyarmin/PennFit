// POST /api/tenant-signup — public self-serve account creation (HTTP
// boundary). The provisioning itself is exercised against the real auth
// repo in staging; here we cover the handler contract: validation,
// honeypot, optional Turnstile, slug derivation, and the
// service-result → status-code mapping.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import type { SelfServeSignupResult } from "../../lib/tenant-signup-service.js";

vi.mock("../../lib/tenant-signup-service.js", async (orig) => {
  const actual =
    await orig<typeof import("../../lib/tenant-signup-service.js")>();
  return { ...actual, createSelfServeTenant: vi.fn() };
});
vi.mock("../../lib/turnstile.js", () => ({
  verifyTurnstile: vi.fn(async () => true),
  turnstileConfigured: () => false,
}));

import { createSelfServeTenant } from "../../lib/tenant-signup-service.js";
import { verifyTurnstile } from "../../lib/turnstile.js";
import tenantSignupRouter from "./tenant-signup.js";

const createMock = vi.mocked(createSelfServeTenant);
const turnstileMock = vi.mocked(verifyTurnstile);

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", tenantSignupRouter);
  return app;
}

const VALID = {
  orgName: "Acme Home Medical",
  email: "owner@acmedme.com",
  password: "a-very-strong-passphrase",
  plan: "growth",
};

beforeEach(() => {
  createMock.mockReset();
  turnstileMock.mockReset();
  turnstileMock.mockResolvedValue(true);
});

describe("POST /api/tenant-signup", () => {
  it("creates the tenant and returns 201 with the slug + sign-in url", async () => {
    const ok: SelfServeSignupResult = {
      ok: true,
      slug: "acme-home-medical",
      signInUrl: "https://cmbreathe.com/admin/sign-in",
    };
    createMock.mockResolvedValue(ok);
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send(VALID);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, slug: "acme-home-medical" });
    // Slug derived from the org name when none supplied; chosen plan forwarded.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgName: "Acme Home Medical",
        slug: "acme-home-medical",
        adminEmail: "owner@acmedme.com",
        plan: "growth",
      }),
    );
  });

  it("400s a missing or non-self-serve plan without provisioning", async () => {
    const { plan: _omit, ...noPlan } = VALID;
    const missing = await request(buildApp())
      .post("/api/tenant-signup")
      .send(noPlan);
    expect(missing.status).toBe(400);
    // Enterprise is custom-quoted — not a self-serve plan.
    const enterprise = await request(buildApp())
      .post("/api/tenant-signup")
      .send({ ...VALID, plan: "enterprise" });
    expect(enterprise.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("maps slug_taken / email_taken to 409", async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: "slug_taken",
      message: "taken",
    });
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send(VALID);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: "slug_taken" });
  });

  it("maps unavailable to 503", async () => {
    createMock.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      message: "later",
    });
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send(VALID);
    expect(res.status).toBe(503);
  });

  it("400s a short password without provisioning", async () => {
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send({ ...VALID, password: "short" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s a missing org name without provisioning", async () => {
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send({ email: VALID.email, password: VALID.password });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("honeypot submissions get fake success and never provision", async () => {
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send({ ...VALID, website: "https://spam.example" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("400s and skips provisioning when Turnstile rejects", async () => {
    turnstileMock.mockResolvedValue(false);
    const res = await request(buildApp())
      .post("/api/tenant-signup")
      .send({ ...VALID, captchaToken: "bad" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});
