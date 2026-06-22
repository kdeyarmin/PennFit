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

describe("GET /platform/tenants/:id", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get(`/platform/tenants/${TENANT_ID}`);
    expect(res.status).toBe(401);
  });

  it("400s on a non-uuid id", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp()).get("/platform/tenants/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("404s when the tenant does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp()).get(`/platform/tenants/${TENANT_ID}`);
    expect(res.status).toBe(404);
  });

  it("returns the tenant detail view (with sender + updated_at)", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: {
        id: TENANT_ID,
        slug: "acme-dme",
        name: "Acme DME",
        storefront_name: "AcmeSleep",
        status: "active",
        custom_domain: "acme.example",
        custom_domain_status: "verified",
        created_at: "2026-02-01T00:00:00Z",
        from_email: "info@acme.example",
        from_name: "Acme DME",
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    const res = await request(makeApp()).get(`/platform/tenants/${TENANT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({
      id: TENANT_ID,
      slug: "acme-dme",
      fromEmail: "info@acme.example",
      fromName: "Acme DME",
      updatedAt: "2026-06-01T00:00:00Z",
    });
  });
});

describe("GET /platform/tenants/:id/feature-flags", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flags`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the tenant does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flags`,
    );
    expect(res.status).toBe(404);
  });

  it("lists the tenant's flags and marks unknown keys non-manageable", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID },
    });
    stageSupabaseResponse("feature_flags", "select", {
      data: [
        {
          key: "admin.assistant",
          enabled: true,
          description: "Admin helper",
          category: "Assistants",
          updated_by_email: "ops@cm",
          updated_at: "2026-06-01T00:00:00Z",
        },
        {
          key: "totally.unknown_future_flag",
          enabled: false,
          description: null,
          category: null,
          updated_by_email: null,
          updated_at: "2026-06-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flags`,
    );
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(2);
    expect(res.body.flags[0]).toMatchObject({
      key: "admin.assistant",
      enabled: true,
      manageable: true,
    });
    // A key this build doesn't know still lists, but can't be toggled, and
    // a null category falls back to "General".
    expect(res.body.flags[1]).toMatchObject({
      key: "totally.unknown_future_flag",
      manageable: false,
      category: "General",
    });
  });
});

describe("PATCH /platform/tenants/:id/feature-flags/:key", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/admin.assistant`)
      .send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it("404s on a flag key this build doesn't know", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/not.a.real.flag`)
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_flag");
  });

  it("400s on a non-uuid tenant id", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp())
      .patch("/platform/tenants/not-a-uuid/feature-flags/admin.assistant")
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_tenant_id");
  });

  it("400s on an invalid body", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/admin.assistant`)
      .send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("404s when the flag isn't seeded for the tenant", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("feature_flags", "select", { data: null });
    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/admin.assistant`)
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("flag_not_seeded");
  });

  it("toggles the flag, writing to the target org + a durable event", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("feature_flags", "select", {
      data: {
        key: "admin.assistant",
        enabled: true,
        description: "Admin helper",
        category: "Assistants",
        updated_by_email: null,
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    stageSupabaseResponse("feature_flags", "update", {
      data: {
        key: "admin.assistant",
        enabled: false,
        description: "Admin helper",
        category: "Assistants",
        updated_by_email: "ops@cm",
        updated_at: "2026-06-02T00:00:00Z",
      },
    });
    stageSupabaseResponse("feature_flag_events", "insert", { error: null });

    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/admin.assistant`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.flag).toMatchObject({
      key: "admin.assistant",
      enabled: false,
    });
    const updates = supabaseMock.writePayloads("feature_flags", "update");
    expect((updates[0] as { enabled: boolean }).enabled).toBe(false);
    // The durable toggle record lands on feature_flag_events for the
    // TARGET org (the same table the tenant's own activity panel reads).
    const events = supabaseMock.writePayloads("feature_flag_events", "insert");
    expect((events[0] as { org_id: string }).org_id).toBe(TENANT_ID);
    expect((events[0] as { next_enabled: boolean }).next_enabled).toBe(false);
  });

  it("no-ops when the flag is already in the requested state", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("feature_flags", "select", {
      data: {
        key: "admin.assistant",
        enabled: true,
        description: "Admin helper",
        category: "Assistants",
        updated_by_email: null,
        updated_at: "2026-06-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .patch(`/platform/tenants/${TENANT_ID}/feature-flags/admin.assistant`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.flag.enabled).toBe(true);
    expect(supabaseMock.callCount("feature_flags", "update")).toBe(0);
  });
});

describe("GET /platform/tenants/:id/feature-flag-activity", () => {
  it("401s for a non-platform-admin", async () => {
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flag-activity`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the tenant does not exist", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", { data: null });
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flag-activity`,
    );
    expect(res.status).toBe(404);
  });

  it("returns recent toggle events for the tenant", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "select", {
      data: { id: TENANT_ID },
    });
    stageSupabaseResponse("feature_flag_events", "select", {
      data: [
        {
          occurred_at: "2026-06-02T00:00:00Z",
          operator_email: "ops@cm",
          key: "admin.assistant",
          previous_enabled: true,
          next_enabled: false,
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/platform/tenants/${TENANT_ID}/feature-flag-activity`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT_ID);
    expect(res.body.activity).toHaveLength(1);
    expect(res.body.activity[0]).toMatchObject({
      key: "admin.assistant",
      operatorEmail: "ops@cm",
      from: true,
      to: false,
    });
  });
});

describe("POST /platform/tenants (create)", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp())
      .post("/platform/tenants")
      .send({ slug: "acme-dme", name: "Acme DME" });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid slug", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    const res = await request(makeApp())
      .post("/platform/tenants")
      .send({ slug: "Not A Slug", name: "Acme DME" });
    expect(res.status).toBe(400);
  });

  it("creates the org shell and provisions feature flags (201)", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "insert", {
      data: {
        id: TENANT_ID,
        slug: "acme-dme",
        name: "Acme DME",
        storefront_name: null,
        status: "active",
        custom_domain: null,
        custom_domain_status: "none",
        created_at: "2026-06-16T00:00:00Z",
      },
    });
    // Feature-flag provisioning: read seed flags, then upsert into the new org.
    stageSupabaseResponse("feature_flags", "select", {
      data: [
        {
          key: "admin.assistant",
          enabled: true,
          description: null,
          category: null,
        },
        {
          key: "email.auto_reply",
          enabled: false,
          description: null,
          category: null,
        },
      ],
    });
    stageSupabaseResponse("feature_flags", "upsert", { error: null });

    const res = await request(makeApp())
      .post("/platform/tenants")
      .send({ slug: "acme-dme", name: "Acme DME" });

    expect(res.status).toBe(201);
    expect(res.body.tenant).toMatchObject({
      slug: "acme-dme",
      status: "active",
    });
    expect(res.body.flagsProvisioned).toBe(2);
    // The flags were upserted onto the NEW org id.
    const upserts = supabaseMock.writePayloads("feature_flags", "upsert");
    expect((upserts[0] as Array<{ org_id: string }>)[0].org_id).toBe(TENANT_ID);
  });

  it("409s when the slug already exists", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });
    const res = await request(makeApp())
      .post("/platform/tenants")
      .send({ slug: "acme-dme", name: "Acme DME" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slug_already_exists");
  });

  it("still 201s when feature-flag provisioning fails (best-effort)", async () => {
    mockPlatformAdmin.current = { userId: "u_p", email: "ops@cm" };
    stageSupabaseResponse("organizations", "insert", {
      data: {
        id: TENANT_ID,
        slug: "acme-dme",
        name: "Acme DME",
        storefront_name: null,
        status: "active",
        custom_domain: null,
        custom_domain_status: "none",
        created_at: "2026-06-16T00:00:00Z",
      },
    });
    // Seed-flag read throws → provisioning fails, but the org create stands.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "boom" },
    });
    const res = await request(makeApp())
      .post("/platform/tenants")
      .send({ slug: "acme-dme", name: "Acme DME" });
    expect(res.status).toBe(201);
    expect(res.body.flagsProvisioned).toBe(0);
  });
});
