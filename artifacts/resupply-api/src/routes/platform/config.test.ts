// Tests for /platform/config — the GLOBAL super-admin System Configuration.
//
// Coverage:
//   1. Gated by requirePlatformAdmin: 401 when the caller isn't a platform
//      admin.
//   2. GET exposes ONLY platform-scoped keys (shared infra) — tenant
//      business keys never appear — and carries the telephony webhook
//      reference. Secrets are masked.
//   3. PUT/DELETE 404 a tenant-scoped key (it isn't managed here) and
//      succeed on a platform key, masking the secret + writing an event.

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

vi.mock("../../middlewares/admin-rate-limit", () => {
  const pass = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();
  return { adminReadRateLimiter: pass, adminWriteRateLimiter: pass };
});

import platformConfigRouter from "./config";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(platformConfigRouter);
  return app;
}

interface SettingView {
  key: string;
  secret: boolean;
  hint: string | null;
  source: string;
}

function flatten(body: {
  categories: Array<{ settings: SettingView[] }>;
}): Map<string, SettingView> {
  const m = new Map<string, SettingView>();
  for (const cat of body.categories) {
    for (const s of cat.settings) m.set(s.key, s);
  }
  return m;
}

function stubPlatformAdmin() {
  mockPlatformAdmin.current = { userId: "u_platform", email: "ops@cm" };
}

beforeEach(() => {
  mockPlatformAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /platform/config", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp()).get("/platform/config");
    expect(res.status).toBe(401);
  });

  it("exposes platform infra keys, hides tenant business keys, masks secrets", async () => {
    stubPlatformAdmin();
    const SECRET = "sk-platform-7f3a";
    stageSupabaseResponse("app_config", "select", {
      data: [
        {
          key: "OPENAI_API_KEY",
          value: SECRET,
          updated_by_email: "ops@cm",
          updated_at: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/platform/config");
    expect(res.status).toBe(200);

    const settings = flatten(res.body);
    const openai = settings.get("OPENAI_API_KEY")!;
    expect(openai.secret).toBe(true);
    expect(openai.source).toBe("db");
    expect(openai.hint).toBe("••••7f3a");

    // Tenant-scoped business keys are NOT managed on the platform surface.
    expect(settings.get("AIRVIEW_CLIENT_SECRET")).toBeUndefined();
    expect(settings.get("OFFICE_ALLY_USERNAME")).toBeUndefined();
    expect(settings.get("RESUPPLY_ASSISTANT_ADMIN_NAME")).toBeUndefined();

    // Telephony webhook reference is platform infra → present here.
    expect(res.body.webhookReference).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe("PUT /platform/config/:key", () => {
  it("401s when the caller is not a platform admin", async () => {
    const res = await request(makeApp())
      .put("/platform/config/OPENAI_API_KEY")
      .send({ value: "sk-x" });
    expect(res.status).toBe(401);
  });

  it("404s a TENANT key so the platform surface can't own a tenant's account", async () => {
    stubPlatformAdmin();
    const res = await request(makeApp())
      .put("/platform/config/AIRVIEW_CLIENT_SECRET")
      .send({ value: "should-be-rejected" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("upserts a platform key, masks the response, and writes an event", async () => {
    stubPlatformAdmin();
    stageSupabaseResponse("app_config", "select", { data: null });
    stageSupabaseResponse("app_config", "upsert", {
      data: {
        key: "OPENAI_API_KEY",
        value: "sk-live-abcd9999",
        updated_by_email: "ops@cm",
        updated_at: "2026-06-02T00:00:00.000Z",
      },
    });

    const res = await request(makeApp())
      .put("/platform/config/OPENAI_API_KEY")
      .send({ value: "sk-live-abcd9999" });

    expect(res.status).toBe(200);
    expect(res.body.setting).toMatchObject({
      key: "OPENAI_API_KEY",
      secret: true,
      source: "db",
      hint: "••••9999",
    });
    expect(JSON.stringify(res.body)).not.toContain("sk-live-abcd9999");

    const events = supabaseMock.writePayloads("app_config_events", "insert");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      key: "OPENAI_API_KEY",
      action: "set",
      operator_email: "ops@cm",
    });
  });
});

describe("DELETE /platform/config/:key", () => {
  it("404s a TENANT key", async () => {
    stubPlatformAdmin();
    const res = await request(makeApp()).delete(
      "/platform/config/OFFICE_ALLY_USERNAME",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_key");
  });

  it("clears a platform key and reports removed", async () => {
    stubPlatformAdmin();
    stageSupabaseResponse("app_config", "delete", {
      data: [{ key: "OPENAI_API_KEY" }],
    });
    const res = await request(makeApp()).delete(
      "/platform/config/OPENAI_API_KEY",
    );
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(true);
  });
});
