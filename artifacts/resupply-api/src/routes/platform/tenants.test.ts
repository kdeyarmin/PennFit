// GET /platform/tenants — platform super-admin tenant directory.
//
// The gate (requirePlatformAdmin) is covered by its own in-house test;
// here we mock it so the route test stays focused on the list contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequirePlatformAdminMock,
  type MockPlatformAdminRef,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: { current: null } as MockPlatformAdminRef,
}));
vi.mock("../../middlewares/requirePlatformAdmin", () =>
  makeRequirePlatformAdminMock(mockPlatformAdmin),
);

import tenantsRouter from "./tenants";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockPlatformAdmin.current = null;
});

describe("GET /platform/tenants", () => {
  it("401s when the caller is not a platform admin (gate rejects)", async () => {
    const res = await request(makeApp()).get("/platform/tenants");
    expect(res.status).toBe(401);
  });

  it("lists every tenant for a platform admin", async () => {
    mockPlatformAdmin.current = { userId: "u_platform_1", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: [
        {
          id: "org-seed",
          slug: "penn-home-medical",
          name: "Penn Home Medical Supply",
          storefront_name: "PennPaps",
          status: "active",
          custom_domain: "pennpaps.com",
          custom_domain_status: "verified",
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "org-acme",
          slug: "acme-dme",
          name: "Acme DME",
          storefront_name: "AcmeSleep",
          status: "suspended",
          custom_domain: null,
          custom_domain_status: "none",
          created_at: "2026-02-01T00:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/platform/tenants");

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(2);
    expect(res.body.tenants[0]).toMatchObject({
      slug: "penn-home-medical",
      storefrontName: "PennPaps",
      status: "active",
      customDomain: "pennpaps.com",
      customDomainStatus: "verified",
    });
    expect(res.body.tenants[1]).toMatchObject({
      slug: "acme-dme",
      status: "suspended",
      customDomain: null,
    });
  });

  it("500s on a directory query error", async () => {
    mockPlatformAdmin.current = { userId: "u_platform_1", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp()).get("/platform/tenants");
    expect(res.status).toBe(500);
  });
});

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /platform/tenants/:id/suspend", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).post(
      `/platform/tenants/${TENANT_ID}/suspend`,
    );
    expect(res.status).toBe(401);
  });

  it("400s on a non-uuid id", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).post(
      "/platform/tenants/not-a-uuid/suspend",
    );
    expect(res.status).toBe(400);
  });

  it("suspends a non-seed tenant", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    // Read (slug = acme, not the seed) then the status update.
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID, slug: "acme-dme", status: "active" },
    });
    stageSupabaseResponse("organizations", "update", {
      data: {
        id: TENANT_ID,
        slug: "acme-dme",
        name: "Acme DME",
        storefront_name: "AcmeSleep",
        status: "suspended",
        custom_domain: null,
        custom_domain_status: "none",
        created_at: "2026-02-01T00:00:00Z",
      },
    });
    const res = await request(makeApp()).post(
      `/platform/tenants/${TENANT_ID}/suspend`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({
      id: TENANT_ID,
      status: "suspended",
    });
  });

  it("refuses to suspend the seed tenant (400)", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID, slug: "penn-home-medical", status: "active" },
    });
    const res = await request(makeApp()).post(
      `/platform/tenants/${TENANT_ID}/suspend`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("cannot_suspend_seed_tenant");
    // No status update should have been issued.
    expect(supabaseMock.callCount("organizations", "update")).toBe(0);
  });

  it("404s when the tenant id does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp()).post(
      `/platform/tenants/${TENANT_ID}/suspend`,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /platform/tenants/:id/reactivate", () => {
  it("reactivates a suspended tenant (and may target the seed org)", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID, slug: "acme-dme", status: "suspended" },
    });
    stageSupabaseResponse("organizations", "update", {
      data: {
        id: TENANT_ID,
        slug: "acme-dme",
        name: "Acme DME",
        storefront_name: "AcmeSleep",
        status: "active",
        custom_domain: null,
        custom_domain_status: "none",
        created_at: "2026-02-01T00:00:00Z",
      },
    });
    const res = await request(makeApp()).post(
      `/platform/tenants/${TENANT_ID}/reactivate`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ status: "active" });
  });
});

describe("GET /platform/tenants/:id/usage", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/usage`,
    );
    expect(res.status).toBe(401);
  });

  it("400s on a non-uuid id", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).get(
      "/platform/tenants/not-a-uuid/usage",
    );
    expect(res.status).toBe(400);
  });

  it("404s when the tenant does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/usage`,
    );
    expect(res.status).toBe(404);
  });

  it("returns per-tenant headline counts", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    // Existence check, then one count per table (count-only head queries).
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID },
    });
    stageSupabaseResponse("patients", "select", { count: 12, data: null });
    stageSupabaseResponse("shop_orders", "select", { count: 5, data: null });
    stageSupabaseResponse("conversations", "select", { count: 3, data: null });

    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/usage`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: TENANT_ID,
      usage: { patients: 12, orders: 5, conversations: 3 },
    });
  });
});
