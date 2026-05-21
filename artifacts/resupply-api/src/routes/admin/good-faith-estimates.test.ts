// Tests for good-faith-estimates route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST /admin/good-faith-estimates
//     (adminRateLimit with preset "sensitive" was REMOVED)
//
// The route still requires requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Route remains protected by requireAdminOnly (401/403).
//   3. Route functions normally without returning 429.
//   4. Validation, org-not-found, and success paths still work.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit spy — verifies it is NOT called ───────────────────────────
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn(
    (_opts: { name: string; preset?: string }) =>
      (_req: import("express").Request, _res: import("express").Response, next: import("express").NextFunction) => {
        next();
      },
  ),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

// ── GFE library mocks ────────────────────────────────────────────────────────
const FAKE_PDF = Buffer.from("fake-gfe-pdf");
const renderGfePdfMock = vi.hoisted(() =>
  vi.fn(async () => ({
    pdf: FAKE_PDF,
    totalCents: 25000,
  })),
);
vi.mock("../../lib/billing/gfe-pdf", () => ({
  renderGfePdf: renderGfePdfMock,
  DEFAULT_GFE_DISCLAIMER: "No Surprises Act disclaimer.",
}));

const resolveBillingIdentityMock = vi.hoisted(() =>
  vi.fn(async () => ({
    source: "db" as const,
    organization: {
      legal_name: "Test DME LLC",
      phone_e164: "+15550001234",
      billing_email: "billing@testdme.com",
    },
    billingProvider: {
      organizationName: "Test DME LLC",
      npi: "1234567890",
      address: {
        line1: "123 Main St",
        city: "Springfield",
        state: "IL",
        zip: "62701",
      },
    },
  })),
);
vi.mock("../../lib/billing/identity-resolver", () => ({
  resolveBillingIdentity: resolveBillingIdentityMock,
}));

import goodFaithEstimatesRouter from "./good-faith-estimates";

const GFE_UUID = "22222222-bbbb-cccc-0000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(goodFaithEstimatesRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

function stubAgent() {
  mockAdmin.current = {
    userId: "u_agent_1",
    email: "agent@example.com",
    role: "agent",
  };
}

const validCreateBody = {
  recipientName: "John Patient",
  recipientEmail: "john@example.com",
  items: [
    {
      description: "CPAP Machine",
      hcpcsCode: "E0601",
      quantity: 1,
      unitPriceCents: 25000,
    },
  ],
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
  renderGfePdfMock.mockClear();
  resolveBillingIdentityMock.mockClear();
});

// ── POST /admin/good-faith-estimates ─────────────────────────────────────────

describe("POST /admin/good-faith-estimates — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called (middleware was removed from this route)", async () => {
    await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "insert", {
      data: { id: GFE_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(res.status).not.toBe(429);
  });

  it("generates PDF and returns 201 with PDF content type", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "insert", {
      data: { id: GFE_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["x-gfe-id"]).toBe(GFE_UUID);
    expect(res.headers["x-gfe-total-cents"]).toBe("25000");
  });

  it("returns 409 when no DME organization is configured", async () => {
    stubAdmin();
    resolveBillingIdentityMock.mockResolvedValueOnce({
      source: "stub" as const,
      organization: null,
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    });
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send(validCreateBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_dme_organization");
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send({ recipientName: "John Patient" }); // missing email, items
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for empty items array", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send({ ...validCreateBody, items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid HCPCS code format", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send({
        ...validCreateBody,
        items: [{ ...validCreateBody.items[0], hcpcsCode: "INVALID" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid email", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send({ ...validCreateBody, recipientEmail: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/good-faith-estimates")
      .send({ ...validCreateBody, unknownField: "oops" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});