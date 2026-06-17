// Tests for /admin/system/config — the TENANT System Configuration store.
//
// Coverage:
//   1. Every route requires `system.config.manage` (the tenant Owner role):
//      401 unauthenticated, 403 for a lower role.
//   2. GET exposes ONLY tenant-scoped keys (branding + the tenant's own
//      business integrations), MASKS secrets, and shows non-secret config
//      in full.
//   3. The security property: shared PLATFORM credentials (OpenAI, Stripe,
//      Twilio, …) never appear here, and PUT/DELETE on a platform key 404s.
//   4. PUT rejects unknown keys (404) and bad bodies (400); on success it
//      upserts, masks the secret, and writes a tenant-scoped event.
//   5. DELETE clears a saved value.

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

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
  adminReadRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

import appConfigRouter from "./app-config";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(appConfigRouter);
  return app;
}

interface SettingView {
  key: string;
  secret: boolean;
  hint: string | null;
  source: string;
  configured: boolean;
  formatValid: boolean | null;
}

function flattenSettings(body: {
  categories: Array<{ settings: SettingView[] }>;
}): Map<string, SettingView> {
  const m = new Map<string, SettingView>();
  for (const cat of body.categories) {
    for (const s of cat.settings) m.set(s.key, s);
  }
  return m;
}

// A secret + a non-secret TENANT-scoped business-integration key.
const TENANT_SECRET_KEY = "AIRVIEW_CLIENT_SECRET";
const TENANT_URL_KEY = "AIRVIEW_API_BASE_URL";

function stubOwner() {
  // role "admin" → granular defaults to "admin" → effective super_admin,
  // which holds system.config.manage (the tenant's Owner).
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "owner@example.com",
    role: "admin",
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/system/config", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/system/config");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-owner role", async () => {
    mockAdmin.current = {
      userId: "u_sup_1",
      email: "supervisor@example.com",
      role: "admin",
      granularRole: "supervisor", // effective "admin", not super_admin
    };
    const res = await request(makeApp()).get("/admin/system/config");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "permission_denied",
      requiredPermission: "system.config.manage",
    });
  });

  it("masks secrets, shows non-secret config, and never leaks a platform credential", async () => {
    stubOwner();
    const SECRET = "av-secret-7f3a";
    stageSupabaseResponse("app_config", "select", {
      data: [
        {
          key: TENANT_SECRET_KEY,
          value: SECRET,
          updated_by_email: "owner@example.com",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        {
          key: TENANT_URL_KEY,
          value: "https://airview.example.com",
          updated_by_email: "owner@example.com",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        {
          // A PLATFORM credential happens to live on this org's rows — it
          // must be filtered OUT of the tenant surface entirely.
          key: "OPENAI_API_KEY",
          value: "sk-platform-secret",
          updated_by_email: "owner@example.com",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/system/config");
    expect(res.status).toBe(200);

    const settings = flattenSettings(res.body);

    // Tenant secret: masked, source db.
    const secret = settings.get(TENANT_SECRET_KEY)!;
    expect(secret.secret).toBe(true);
    expect(secret.source).toBe("db");
    expect(secret.configured).toBe(true);
    expect(secret.hint).toBe("••••7f3a");

    // Tenant non-secret config: shown in full; URL rule passes.
    const url = settings.get(TENANT_URL_KEY)!;
    expect(url.secret).toBe(false);
    expect(url.hint).toBe("https://airview.example.com");
    expect(url.formatValid).toBe(true);

    // The security property: shared platform credentials never appear here.
    expect(settings.get("OPENAI_API_KEY")).toBeUndefined();
    expect(settings.get("STRIPE_SECRET_KEY")).toBeUndefined();
    expect(settings.get("TWILIO_AUTH_TOKEN")).toBeUndefined();

    // Telephony webhooks are platform-scoped — not on the tenant surface.
    expect(res.body.webhookReference).toBeNull();
    expect(res.body.twilioWebhooks).toBeNull();

    // Hard guarantee: no secret plaintext anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(JSON.stringify(res.body)).not.toContain("sk-platform-secret");
  });
});

describe("PUT /admin/system/config/:key", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .put(`/admin/system/config/${TENANT_SECRET_KEY}`)
      .send({ value: "x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown key", async () => {
    stubOwner();
    const res = await request(makeApp())
      .put("/admin/system/config/NOT_A_REAL_KEY")
      .send({ value: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("404s a PLATFORM key so the tenant surface can't write a shared secret", async () => {
    stubOwner();
    const res = await request(makeApp())
      .put("/admin/system/config/OPENAI_API_KEY")
      .send({ value: "sk-should-be-rejected" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("returns 400 for an empty value", async () => {
    stubOwner();
    const res = await request(makeApp())
      .put(`/admin/system/config/${TENANT_SECRET_KEY}`)
      .send({ value: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("upserts the value, masks the response, and writes a tenant-scoped event", async () => {
    stubOwner();
    stageSupabaseResponse("app_config", "select", { data: null });
    stageSupabaseResponse("app_config", "upsert", {
      data: {
        key: TENANT_SECRET_KEY,
        value: "av-live-abcd9999",
        updated_by_email: "owner@example.com",
        updated_at: "2026-06-02T00:00:00.000Z",
      },
    });

    const res = await request(makeApp())
      .put(`/admin/system/config/${TENANT_SECRET_KEY}`)
      .send({ value: "av-live-abcd9999" });

    expect(res.status).toBe(200);
    expect(res.body.setting).toMatchObject({
      key: TENANT_SECRET_KEY,
      secret: true,
      source: "db",
      hint: "••••9999",
    });
    expect(JSON.stringify(res.body)).not.toContain("av-live-abcd9999");

    const upserts = supabaseMock.writePayloads("app_config", "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      key: TENANT_SECRET_KEY,
      value: "av-live-abcd9999",
      updated_by_email: "owner@example.com",
    });
    expect((upserts[0] as Record<string, unknown>).org_id).toBeTruthy();

    const events = supabaseMock.writePayloads("app_config_events", "insert");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: TENANT_SECRET_KEY,
      action: "set",
      had_previous: false,
      operator_email: "owner@example.com",
    });
    expect((events[0] as Record<string, unknown>).org_id).toBeTruthy();
  });
});

describe("DELETE /admin/system/config/:key", () => {
  it("returns 403 for a non-owner role", async () => {
    mockAdmin.current = {
      userId: "u_csr_1",
      email: "csr@example.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp()).delete(
      `/admin/system/config/${TENANT_SECRET_KEY}`,
    );
    expect(res.status).toBe(403);
  });

  it("404s a PLATFORM key on delete too", async () => {
    stubOwner();
    const res = await request(makeApp()).delete(
      "/admin/system/config/STRIPE_SECRET_KEY",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("clears a saved value and reports removed", async () => {
    stubOwner();
    stageSupabaseResponse("app_config", "delete", {
      data: [{ key: TENANT_SECRET_KEY }],
    });

    const res = await request(makeApp()).delete(
      `/admin/system/config/${TENANT_SECRET_KEY}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(res.body.setting.key).toBe(TENANT_SECRET_KEY);

    const events = supabaseMock.writePayloads("app_config_events", "insert");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: TENANT_SECRET_KEY,
      action: "clear",
    });
  });
});
