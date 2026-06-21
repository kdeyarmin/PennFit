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
import { type MockBillingIdentity } from "../../test-helpers/billing-mocks";

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
      (
        _req: import("express").Request,
        _res: import("express").Response,
        next: import("express").NextFunction,
      ) => {
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
  vi.fn<() => Promise<MockBillingIdentity>>(async () => ({
    source: "db",
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

// ── Tenant SendGrid mock ─────────────────────────────────────────────────────
type SentEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: Array<{
    content: Buffer;
    filename: string;
    contentType: string;
  }>;
};
const sendEmailMock = vi.hoisted(() =>
  vi.fn(async (_input: SentEmail) => ({ messageId: "msg-1" })),
);
const createTenantSendgridClientMock = vi.hoisted(() =>
  vi.fn(async () => ({ sendEmail: sendEmailMock })),
);
vi.mock("../../lib/email/tenant-sender", () => ({
  createTenantSendgridClient: createTenantSendgridClientMock,
}));

import { EmailConfigError } from "@workspace/resupply-email";

import goodFaithEstimatesRouter from "./good-faith-estimates";

const GFE_UUID = "22222222-bbbb-4ccc-8000-000000000001";

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
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "msg-1" });
  createTenantSendgridClientMock.mockClear();
});

const STORED_ROW = {
  id: GFE_UUID,
  recipient_name: "John Patient",
  recipient_email: "john@example.com",
  items_json: [
    {
      description: "CPAP Machine",
      hcpcsCode: "E0601",
      quantity: 1,
      unitPriceCents: 25000,
    },
  ],
  total_cents: 25000,
  expected_service_date: null,
  disclaimer_text: "No Surprises Act disclaimer.",
  delivery_method: null,
  delivered_at: null,
};

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

// ── POST /admin/good-faith-estimates/:id/email ───────────────────────────────

describe("POST /admin/good-faith-estimates/:id/email", () => {
  const url = `/admin/good-faith-estimates/${GFE_UUID}/email`;

  it("401 unauthenticated", async () => {
    expect((await request(makeApp()).post(url).send({})).status).toBe(401);
  });

  it("403 for a non-admin agent", async () => {
    stubAgent();
    expect((await request(makeApp()).post(url).send({})).status).toBe(403);
  });

  it("emails the rendered PDF and stamps delivered_at + delivery_method=email", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", {
      data: STORED_ROW,
    });
    stageSupabaseResponse("good_faith_estimates", "update", { data: null });

    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body.deliveryMethod).toBe("email");
    expect(res.body.deliveredAt).toBeTruthy();
    // The PDF rode along as an attachment.
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const sent = sendEmailMock.mock.calls[0]![0];
    expect(sent.to).toBe("john@example.com");
    expect(sent.attachments?.[0]?.contentType).toBe("application/pdf");
    // delivered_at + method were stamped.
    const writes = supabaseMock.writePayloads("good_faith_estimates", "update");
    expect(writes[0]).toMatchObject({ delivery_method: "email" });
    expect(writes[0]).toHaveProperty("delivered_at");
  });

  it("404 when the GFE does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
  });

  it("409 when no DME organization is configured", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", {
      data: STORED_ROW,
    });
    resolveBillingIdentityMock.mockResolvedValueOnce({
      source: "stub" as const,
      organization: null,
      billingProvider: {
        organizationName: "Stub",
        npi: "0000000000",
        address: { line1: "", city: "", state: "", zip: "" },
      },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_dme_organization");
  });

  it("503 when SendGrid is not configured (no stamp)", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", {
      data: STORED_ROW,
    });
    sendEmailMock.mockRejectedValueOnce(new EmailConfigError("no key"));
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_not_configured");
    // Nothing was sent → no delivered_at stamp.
    expect(
      supabaseMock.writePayloads("good_faith_estimates", "update"),
    ).toHaveLength(0);
  });

  it("502 on a transient send failure (no stamp)", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", {
      data: STORED_ROW,
    });
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid 503"));
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(502);
    expect(
      supabaseMock.writePayloads("good_faith_estimates", "update"),
    ).toHaveLength(0);
  });
});

// ── POST /admin/good-faith-estimates/:id/deliver ─────────────────────────────

describe("POST /admin/good-faith-estimates/:id/deliver", () => {
  const url = `/admin/good-faith-estimates/${GFE_UUID}/deliver`;

  it("401 unauthenticated", async () => {
    expect(
      (await request(makeApp()).post(url).send({ deliveryMethod: "mail" }))
        .status,
    ).toBe(401);
  });

  it("400 for an invalid delivery method (CHECK-constraint enum)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(url)
      .send({ deliveryMethod: "carrier_pigeon" });
    expect(res.status).toBe(400);
  });

  it("marks delivered out-of-band: stamps delivered_at + the channel", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", {
      data: { id: GFE_UUID },
    });
    stageSupabaseResponse("good_faith_estimates", "update", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ deliveryMethod: "mail" });
    expect(res.status).toBe(200);
    expect(res.body.deliveryMethod).toBe("mail");
    const writes = supabaseMock.writePayloads("good_faith_estimates", "update");
    expect(writes[0]).toMatchObject({ delivery_method: "mail" });
    expect(writes[0]).toHaveProperty("delivered_at");
    // Mark-delivered never sends email.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("404 when the GFE does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("good_faith_estimates", "select", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ deliveryMethod: "mail" });
    expect(res.status).toBe(404);
  });
});
