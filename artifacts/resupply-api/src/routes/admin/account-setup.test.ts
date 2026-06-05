// Route + assembler tests for /admin/account-setup (new-account /
// production launch checklist).
//
//   * buildChecklistItems(...) — pure assembler: env booleans flip the
//     required/optional rows; DB-probe outcomes pass straight through;
//     env VALUES never leak into the response.
//   * GET /admin/account-setup — 401 without admin, 200 shape with the
//     two DB probes staged (schema present + first-admin count).

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

import accountSetupRouter, {
  buildChecklistItems,
  type AccountSetupItem,
  type ProbeResult,
} from "./account-setup";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(accountSetupRouter);
  return app;
}

const OK: ProbeResult = { status: "complete", detail: "ok" };

function byId(items: AccountSetupItem[], id: string): AccountSetupItem {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`no checklist item with id ${id}`);
  return found;
}

const REQUIRED_ENV_IDS = [
  "env-database-url",
  "env-supabase",
  "env-link-hmac",
  "env-cors",
  "env-storage-bucket",
] as const;

describe("buildChecklistItems", () => {
  it("marks every required-env item incomplete with an empty env", () => {
    const items = buildChecklistItems({
      env: {},
      linkHmacConfigured: false,
      schema: OK,
      admin: OK,
    });
    for (const id of REQUIRED_ENV_IDS) {
      expect(byId(items, id).status).toBe("incomplete");
    }
  });

  it("marks required-env items complete once their vars are set", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://x",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app",
      SUPABASE_STORAGE_BUCKET_PRIVATE: "attachments",
    };
    const items = buildChecklistItems({
      env,
      linkHmacConfigured: true,
      schema: OK,
      admin: OK,
    });
    for (const id of REQUIRED_ENV_IDS) {
      expect(byId(items, id).status).toBe("complete");
    }
  });

  it("accepts RESUPPLY_ALLOWED_ORIGINS as satisfying the CORS row", () => {
    const items = buildChecklistItems({
      env: { RESUPPLY_ALLOWED_ORIGINS: "https://x" },
      linkHmacConfigured: false,
      schema: OK,
      admin: OK,
    });
    expect(byId(items, "env-cors").status).toBe("complete");
  });

  it("uses the injected linkHmacConfigured flag for the HMAC row", () => {
    const off = buildChecklistItems({
      env: {},
      linkHmacConfigured: false,
      schema: OK,
      admin: OK,
    });
    expect(byId(off, "env-link-hmac").status).toBe("incomplete");
    expect(byId(off, "env-link-hmac").command).toContain("openssl");

    const on = buildChecklistItems({
      env: {},
      linkHmacConfigured: true,
      schema: OK,
      admin: OK,
    });
    expect(byId(on, "env-link-hmac").status).toBe("complete");
    expect(byId(on, "env-link-hmac").command).toBeNull();
  });

  it("passes the DB-probe outcomes straight through", () => {
    const items = buildChecklistItems({
      env: {},
      linkHmacConfigured: false,
      schema: { status: "unknown", detail: "db down" },
      admin: { status: "incomplete", detail: "no admins" },
    });
    expect(byId(items, "db-schema").status).toBe("unknown");
    expect(byId(items, "db-schema").detail).toBe("db down");
    expect(byId(items, "first-admin").status).toBe("incomplete");
    // bootstrap command surfaces only while no admin exists
    expect(byId(items, "first-admin").command).toContain(
      "auth:bootstrap-admin",
    );
  });

  it("drops the bootstrap command once an admin exists", () => {
    const items = buildChecklistItems({
      env: {},
      linkHmacConfigured: false,
      schema: OK,
      admin: { status: "complete", detail: "1 admin" },
    });
    expect(byId(items, "first-admin").command).toBeNull();
  });

  it("keeps the operator-run steps as manual with a command", () => {
    const items = buildChecklistItems({
      env: {},
      linkHmacConfigured: true,
      schema: OK,
      admin: OK,
    });
    for (const id of ["db-migrations", "preflight", "smoke-test"]) {
      expect(byId(items, id).status).toBe("manual");
      expect(byId(items, id).command).toBeTruthy();
    }
  });

  it("flips optional vendor rows on when their env triple is present", () => {
    const env: NodeJS.ProcessEnv = {
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_x",
      SENDGRID_API_KEY: "SG.x",
      SENDGRID_FROM_EMAIL: "info@pennpaps.com",
      ANTHROPIC_API_KEY: "sk-ant-x",
    };
    const items = buildChecklistItems({
      env,
      linkHmacConfigured: false,
      schema: OK,
      admin: OK,
    });
    expect(byId(items, "vendor-stripe").status).toBe("complete");
    expect(byId(items, "vendor-sendgrid").status).toBe("complete");
    expect(byId(items, "vendor-anthropic").status).toBe("complete");
    // not configured -> incomplete (the optional-tab "not set up" state)
    expect(byId(items, "vendor-openai").status).toBe("incomplete");
    expect(byId(items, "vendor-twilio-voice").status).toBe("incomplete");
  });

  it("flags Stripe configured-but-missing-webhook", () => {
    const items = buildChecklistItems({
      env: { STRIPE_SECRET_KEY: "sk_live_x" },
      linkHmacConfigured: false,
      schema: OK,
      admin: OK,
    });
    const stripe = byId(items, "vendor-stripe");
    expect(stripe.status).toBe("complete");
    expect(stripe.detail).toContain("webhook");
  });

  it("never leaks an env VALUE into any response field", () => {
    const secret = "sk_live_SUPERSECRETVALUE";
    const items = buildChecklistItems({
      env: {
        STRIPE_SECRET_KEY: secret,
        SUPABASE_SERVICE_ROLE_KEY: "JWTSECRETVALUE",
      },
      linkHmacConfigured: true,
      schema: OK,
      admin: OK,
    });
    const blob = JSON.stringify(items);
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain("JWTSECRETVALUE");
  });
});

describe("GET /admin/account-setup", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
  });

  it("401s without admin", async () => {
    const res = await request(makeApp()).get("/admin/account-setup");
    expect(res.status).toBe(401);
  });

  it("returns the checklist for an admin (schema + admin probes succeed)", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    stageSupabaseResponse("feature_flags", "select", {
      data: null,
      count: 0,
      error: null,
    });
    stageSupabaseResponse("admin_users", "select", {
      data: null,
      count: 2,
      error: null,
    });
    const res = await request(makeApp()).get("/admin/account-setup");
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe("string");
    expect(Array.isArray(res.body.items)).toBe(true);

    const items = res.body.items as AccountSetupItem[];
    expect(items.some((i) => i.tab === "required")).toBe(true);
    expect(items.some((i) => i.tab === "optional")).toBe(true);
    expect(byId(items, "db-schema").status).toBe("complete");
    expect(byId(items, "first-admin").status).toBe("complete");
  });

  it("reports first-admin incomplete when no admins exist", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    stageSupabaseResponse("feature_flags", "select", {
      data: null,
      count: 0,
      error: null,
    });
    stageSupabaseResponse("admin_users", "select", {
      data: null,
      count: 0,
      error: null,
    });
    const res = await request(makeApp()).get("/admin/account-setup");
    const items = res.body.items as AccountSetupItem[];
    expect(byId(items, "first-admin").status).toBe("incomplete");
  });

  it("marks the schema row unknown when the DB query errors", async () => {
    mockAdmin.current = { userId: "u", email: "ops@x", role: "admin" };
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: 'relation "resupply.feature_flags" does not exist' },
    });
    stageSupabaseResponse("admin_users", "select", {
      error: { message: 'relation "resupply.admin_users" does not exist' },
    });
    const res = await request(makeApp()).get("/admin/account-setup");
    expect(res.status).toBe(200);
    const items = res.body.items as AccountSetupItem[];
    expect(byId(items, "db-schema").status).toBe("unknown");
    expect(byId(items, "first-admin").status).toBe("unknown");
  });
});
