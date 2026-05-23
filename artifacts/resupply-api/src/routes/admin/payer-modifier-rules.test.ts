// Tests for payer-modifier-rules route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST  /admin/payer-modifier-rules       (adminRateLimit with preset "sensitive" REMOVED)
//   - PATCH /admin/payer-modifier-rules/:id   (adminRateLimit with preset "sensitive" REMOVED)
//
// Both routes still require requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Routes remain protected by requireAdminOnly (401/403).
//   3. Routes function normally without returning 429.
//   4. Validation and CRUD behavior still works.

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

import payerModifierRulesRouter from "./payer-modifier-rules";

const RULE_UUID = "55555555-eeee-4fff-8000-000000000001";
const PAYER_PROFILE_UUID = "66666666-ffff-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(payerModifierRulesRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "billing@example.com",
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
  payerProfileId: PAYER_PROFILE_UUID,
  hcpcsCode: "E0601",
  modifiersCsv: "KX",
  condition: "always",
  priority: 100,
  isActive: true,
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── POST /admin/payer-modifier-rules ─────────────────────────────────────────

describe("POST /admin/payer-modifier-rules — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for POST (middleware was removed)", async () => {
    await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send(validCreateBody);
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_modifier_rules", "insert", {
      data: { id: RULE_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send(validCreateBody);
    expect(res.status).not.toBe(429);
  });

  it("creates modifier rule and returns 201 with id", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_modifier_rules", "insert", {
      data: { id: RULE_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(RULE_UUID);
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send({ payerProfileId: PAYER_PROFILE_UUID }); // missing hcpcsCode, modifiersCsv
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid HCPCS code format", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send({ ...validCreateBody, hcpcsCode: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid modifiers CSV format", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send({ ...validCreateBody, modifiersCsv: "K" }); // must be 2-char
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid condition value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send({ ...validCreateBody, condition: "invalid_condition" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-modifier-rules")
      .send({ ...validCreateBody, unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── PATCH /admin/payer-modifier-rules/:id ────────────────────────────────────

describe("PATCH /admin/payer-modifier-rules/:id — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for PATCH (middleware was removed)", async () => {
    await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: false });
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_modifier_rules", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: false });
    expect(res.status).not.toBe(429);
  });

  it("updates modifier rule and returns 200 with ok=true", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_modifier_rules", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when id is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/payer-modifier-rules/not-a-uuid")
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid HCPCS code in patch body", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ hcpcsCode: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("allows partial updates (only isActive)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_modifier_rules", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/payer-modifier-rules/${RULE_UUID}`)
      .send({ isActive: true }); // only one field
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});