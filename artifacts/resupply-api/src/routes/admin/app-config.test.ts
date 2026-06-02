// Tests for /admin/system/config — super-admin System Configuration.
//
// Coverage:
//   1. Every route requires `system.config.manage` (super_admin only):
//      401 unauthenticated, 403 for a non-super role.
//   2. GET groups the catalog by category and MASKS secret values —
//      the plaintext never appears in the response.
//   3. Non-secret config is returned in full.
//   4. PUT rejects unknown keys (404) and bad bodies (400); on success
//      it upserts, masks the secret in the response, and writes an
//      app_config_events row.
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

function stubSuperAdmin() {
  // role "admin" → granular defaults to "admin" → effective super_admin,
  // which holds every permission including system.config.manage.
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

  it("returns 403 for a non-super-admin role", async () => {
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

  it("masks secret values and never leaks the plaintext", async () => {
    stubSuperAdmin();
    const SECRET = "sk-super-secret-7f3a";
    stageSupabaseResponse("app_config", "select", {
      data: [
        {
          key: "OPENAI_API_KEY",
          value: SECRET,
          updated_by_email: "owner@example.com",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
        {
          key: "AIRVIEW_API_BASE_URL",
          value: "https://airview.example.com",
          updated_by_email: "owner@example.com",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/system/config");
    expect(res.status).toBe(200);

    const settings = flattenSettings(res.body);
    const openai = settings.get("OPENAI_API_KEY")!;
    expect(openai.secret).toBe(true);
    expect(openai.source).toBe("db");
    expect(openai.configured).toBe(true);
    // Masked — only the last 4 chars revealed.
    expect(openai.hint).toBe("••••7f3a");

    // Non-secret config is shown in full.
    const airview = settings.get("AIRVIEW_API_BASE_URL")!;
    expect(airview.secret).toBe(false);
    expect(airview.hint).toBe("https://airview.example.com");

    // Hard guarantee: the secret plaintext is nowhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe("PUT /admin/system/config/:key", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .put("/admin/system/config/OPENAI_API_KEY")
      .send({ value: "sk-x" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown key", async () => {
    stubSuperAdmin();
    const res = await request(makeApp())
      .put("/admin/system/config/NOT_A_REAL_KEY")
      .send({ value: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("returns 400 for an empty value", async () => {
    stubSuperAdmin();
    const res = await request(makeApp())
      .put("/admin/system/config/OPENAI_API_KEY")
      .send({ value: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("upserts the value, masks the response, and writes an event", async () => {
    stubSuperAdmin();
    // prior-row probe → no existing value
    stageSupabaseResponse("app_config", "select", { data: null });
    // upsert RETURNING row
    stageSupabaseResponse("app_config", "upsert", {
      data: {
        key: "OPENAI_API_KEY",
        value: "sk-live-abcd9999",
        updated_by_email: "owner@example.com",
        updated_at: "2026-06-02T00:00:00.000Z",
      },
    });

    const res = await request(makeApp())
      .put("/admin/system/config/OPENAI_API_KEY")
      .send({ value: "sk-live-abcd9999" });

    expect(res.status).toBe(200);
    expect(res.body.setting).toMatchObject({
      key: "OPENAI_API_KEY",
      secret: true,
      source: "db",
      hint: "••••9999",
    });
    expect(JSON.stringify(res.body)).not.toContain("sk-live-abcd9999");

    // The upsert payload carried the actor + value.
    const upserts = supabaseMock.writePayloads("app_config", "upsert");
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      key: "OPENAI_API_KEY",
      value: "sk-live-abcd9999",
      updated_by_email: "owner@example.com",
    });

    // An app_config_events row was written (value-free).
    const events = supabaseMock.writePayloads("app_config_events", "insert");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: "OPENAI_API_KEY",
      action: "set",
      had_previous: false,
      operator_email: "owner@example.com",
    });
  });
});

describe("DELETE /admin/system/config/:key", () => {
  it("returns 403 for a non-super-admin role", async () => {
    mockAdmin.current = {
      userId: "u_csr_1",
      email: "csr@example.com",
      role: "agent",
      granularRole: "csr",
    };
    const res = await request(makeApp()).delete(
      "/admin/system/config/OPENAI_API_KEY",
    );
    expect(res.status).toBe(403);
  });

  it("clears a saved value and reports removed", async () => {
    stubSuperAdmin();
    // delete RETURNING the removed row
    stageSupabaseResponse("app_config", "delete", {
      data: [{ key: "OPENAI_API_KEY" }],
    });

    const res = await request(makeApp()).delete(
      "/admin/system/config/OPENAI_API_KEY",
    );
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
    expect(res.body.setting.key).toBe("OPENAI_API_KEY");

    const events = supabaseMock.writePayloads("app_config_events", "insert");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ key: "OPENAI_API_KEY", action: "clear" });
  });
});
