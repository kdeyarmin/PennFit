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
