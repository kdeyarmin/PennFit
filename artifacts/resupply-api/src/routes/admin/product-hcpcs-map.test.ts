// Tests for product-hcpcs-map route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST  /admin/product-hcpcs-map      (adminRateLimit with preset "sensitive" REMOVED)
//   - PATCH /admin/product-hcpcs-map/:id  (adminRateLimit with preset "mutation" REMOVED)
//
// Both routes still require requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Routes remain protected by requireAdminOnly (401/403).
//   3. Routes function normally without returning 429.
//   4. Validation and CRUD behavior (including 409 conflict) still works.

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

// ── Platform-admin gate on the GLOBAL-table writes ───────────────────────────
// `product_hcpcs_map` has no org_id, so POST/PATCH chain
// requirePlatformAdminForGlobalWrite after requireAdminOnly. Default the mock
// to "is a platform admin" so the pre-existing CRUD/validation cases below keep
// exercising the handler; the gate itself is covered explicitly further down.
const { mockIsPlatformAdmin } = vi.hoisted(() => ({
  mockIsPlatformAdmin: { current: true as boolean | "unknown" },
}));
vi.mock("../../middlewares/requirePlatformAdmin", () => ({
  requirePlatformAdminForGlobalWrite: (
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    if (!req.adminUserId) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    if (mockIsPlatformAdmin.current === "unknown") {
      res.status(503).json({ error: "authorization_unavailable" });
      return;
    }
    if (!mockIsPlatformAdmin.current) {
      res.status(403).json({ error: "platform_admin_required" });
      return;
    }
    next();
  },
}));

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

import productHcpcsMapRouter from "./product-hcpcs-map";

const MAP_UUID = "77777777-0000-1111-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(productHcpcsMapRouter);
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
  lookupKind: "item_sku",
  lookupValue: "CPAP-001",
  hcpcsCode: "E0601",
  unitsPerDispense: 1,
  isActive: true,
};

beforeEach(() => {
  mockAdmin.current = null;
  mockIsPlatformAdmin.current = true;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── Platform-global write gate ────────────────────────────────────────────────
//
// `resupply.product_hcpcs_map` has no `org_id` and is unique on
// `(lookup_kind, lookup_value)`, so its rows are shared by every tenant, and
// claim-builder reads `hcpcs_code` / `default_billed_cents` off them onto real
// 837P lines. On `requireAdminOnly` alone, one tenant's admin could PATCH by row
// id — which the org-scoped client cannot narrow on a table with no org_id — and
// change what every other tenant bills.
describe("platform-global write gate", () => {
  it("rejects a tenant admin who is not a platform admin on POST", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("platform_admin_required");
  });

  it("rejects a tenant admin who is not a platform admin on PATCH", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ defaultBilledCents: 21000 });
    expect(res.status).toBe(403);
  });

  it("never reaches the handler when the gate rejects", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ defaultBilledCents: 21000 });
    // No write was attempted against the shared catalog.
    expect(supabaseMock.callCount("product_hcpcs_map", "update")).toBe(0);
  });

  it("fails closed with 503 when platform membership cannot be verified", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = "unknown";
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(503);
  });

  it("leaves GET open to a tenant admin — reference data stays readable", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    stageSupabaseResponse("product_hcpcs_map", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/product-hcpcs-map");
    expect(res.status).toBe(200);
  });
});

// ── POST /admin/product-hcpcs-map ─────────────────────────────────────────────

describe("POST /admin/product-hcpcs-map — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for POST (middleware was removed)", async () => {
    await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "insert", {
      data: { id: MAP_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).not.toBe(429);
  });

  it("creates mapping and returns 201 with id", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "insert", {
      data: { id: MAP_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MAP_UUID);
  });

  it("returns 409 on lookup conflict (unique constraint violation)", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "insert", {
      data: null,
      error: { code: "23505", message: "unique constraint violation" },
    });
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send(validCreateBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("lookup_conflict");
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send({ lookupKind: "item_sku" }); // missing lookupValue, hcpcsCode
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid lookupKind value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send({ ...validCreateBody, lookupKind: "invalid_kind" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid HCPCS code format", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send({ ...validCreateBody, hcpcsCode: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send({ ...validCreateBody, unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("normalizes HCPCS code to uppercase", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "insert", {
      data: { id: MAP_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/product-hcpcs-map")
      .send({ ...validCreateBody, hcpcsCode: "e0601" }); // lowercase
    expect(res.status).toBe(201);
  });
});

// ── PATCH /admin/product-hcpcs-map/:id ───────────────────────────────────────

describe("PATCH /admin/product-hcpcs-map/:id — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for PATCH (middleware was removed)", async () => {
    await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ isActive: false });
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter present)", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ isActive: false });
    expect(res.status).not.toBe(429);
  });

  it("updates mapping and returns 200 with ok=true", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when id is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/product-hcpcs-map/not-a-uuid")
      .send({ isActive: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid HCPCS code in patch body", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ hcpcsCode: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("allows partial updates (only description)", async () => {
    stubAdmin();
    stageSupabaseResponse("product_hcpcs_map", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ description: "Updated CPAP mapping" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("validates defaultBilledCents must be a non-negative integer", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/product-hcpcs-map/${MAP_UUID}`)
      .send({ defaultBilledCents: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
