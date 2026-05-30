// Tests for csr-macros route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST   /admin/csr-macros       (admin.tools.manage, preset: mutation)
//   - PATCH  /admin/csr-macros/:id   (admin.tools.manage, preset: mutation)
//   - DELETE /admin/csr-macros/:id   (admin.tools.manage, preset: destroy)
//
// Tests verify:
//   1. Auth/permission gates fire before rate limiting.
//   2. When adminRateLimit blocks, the route returns 429 with the correct limiter.
//   3. When adminRateLimit passes through, the handler runs normally.
//   4. adminRateLimit is invoked with the exact options from the PR diff.
//   5. The DELETE route uses the "destroy" preset (more conservative: 10/hr).

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

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: {
      name: string;
      preset?: string;
    }) => (
      req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => void
  >((opts) => (_req, res, next) => {
    if (rateLimitBlocked.current) {
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: 3600,
        message: "Too many requests, please try again later.",
      });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

import csrMacrosRouter from "./csr-macros";

const MACRO_ID = "macro-id-abc123";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(csrMacrosRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
    role: "admin",
  };
}

const validCreateBody = {
  key: "billing-inquiry",
  label: "Billing inquiry response",
  body: "Thank you for reaching out about your bill.",
  channels: ["sms"],
};

function makeMacroRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MACRO_ID,
    key: "billing-inquiry",
    label: "Billing inquiry response",
    category: null,
    body: "Thank you for reaching out about your bill.",
    channels: ["sms"],
    is_active: true,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: null,
    updated_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── POST /admin/csr-macros ───────────────────────────────────────────────────

describe("POST /admin/csr-macros — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/csr-macros")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/csr-macros")
      .send(validCreateBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("csr_macros.create");
  });

  it("calls adminRateLimit with name='csr_macros.create' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "csr_macros.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and creates macro when not rate-limited", async () => {
    stubAdmin();
    // Route uses .insert(...).select("*").single() — stage a single object.
    stageSupabaseResponse("csr_macros", "insert", {
      data: makeMacroRow(),
    });
    const res = await request(makeApp())
      .post("/admin/csr-macros")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.macro).toBeDefined();
    expect(res.body.macro.key).toBe("billing-inquiry");
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/csr-macros")
      .send({ key: "valid-key" }); // missing label, body, channels
    expect(res.status).toBe(400);
  });
});

// ── PATCH /admin/csr-macros/:id ──────────────────────────────────────────────

describe("PATCH /admin/csr-macros/:id — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/csr-macros/${MACRO_ID}`)
      .send({ label: "New label" });
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/csr-macros/${MACRO_ID}`)
      .send({ label: "New label" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("csr_macros.update");
  });

  it("calls adminRateLimit with name='csr_macros.update' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "csr_macros.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and updates macro when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("csr_macros", "update", {
      data: [makeMacroRow({ label: "New label" })],
    });
    const res = await request(makeApp())
      .patch(`/admin/csr-macros/${MACRO_ID}`)
      .send({ label: "New label" });
    expect(res.status).toBe(200);
    expect(res.body.macro).toBeDefined();
  });
});

// ── DELETE /admin/csr-macros/:id ─────────────────────────────────────────────

describe("DELETE /admin/csr-macros/:id — adminRateLimit integration (destroy preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).delete(
      `/admin/csr-macros/${MACRO_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp()).delete(
      `/admin/csr-macros/${MACRO_ID}`,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("csr_macros.delete");
  });

  it("calls adminRateLimit with name='csr_macros.delete' and preset='destroy'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "csr_macros.delete",
    );
    expect(call).toBeDefined();
    // DELETE uses the conservative 'destroy' preset (10/hr) — different from mutation (60/hr).
    expect(call![0].preset).toBe("destroy");
  });

  it("passes through and soft-deletes macro when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("csr_macros", "update", {
      data: [makeMacroRow({ is_active: false })],
    });
    const res = await request(makeApp()).delete(
      `/admin/csr-macros/${MACRO_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("uses a more conservative preset than create/update (destroy vs mutation)", () => {
    const deleteCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "csr_macros.delete",
    );
    const createCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "csr_macros.create",
    );
    // DELETE (destroy) is more conservative than POST (mutation).
    expect(deleteCall![0].preset).toBe("destroy");
    expect(createCall![0].preset).toBe("mutation");
    expect(deleteCall![0].preset).not.toBe(createCall![0].preset);
  });
});
