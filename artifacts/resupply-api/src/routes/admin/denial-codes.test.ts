// Tests for denial-codes route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - POST  /admin/denial-codes       (requireAdminOnly, preset: sensitive)
//   - PATCH /admin/denial-codes/:id   (requireAdminOnly, preset: mutation)
//
// Key PR detail: POST uses "sensitive" (30/hr) while PATCH uses "mutation"
// (60/hr). Tests verify both routes got the correct preset.
//
// Tests verify:
//   1. requireAdminOnly gates fire before rate limiting.
//   2. Agents (non-admin) are rejected with 403.
//   3. When adminRateLimit blocks, the route returns 429 with the correct limiter.
//   4. When adminRateLimit passes through, the handler runs normally.
//   5. adminRateLimit is invoked with the exact options from the PR diff.

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
// CARC/RARC are national code sets and `denial_codes` stores them with no
// org_id, so POST/PATCH chain requirePlatformAdminForGlobalWrite. Default to
// "is a platform admin" so the existing CRUD cases still reach the handler.
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

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import denialCodesRouter from "./denial-codes";

const CODE_ID = "11111111-aaaa-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(denialCodesRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@example.com",
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
  codeSystem: "carc",
  code: "CO97",
  description: "The benefit for this service is included in the payment",
  category: "other",
  isTerminal: false,
};

beforeEach(() => {
  mockAdmin.current = null;
  mockIsPlatformAdmin.current = true;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── Platform-global write gate ────────────────────────────────────────────────
//
// `resupply.denial_codes` has no `org_id` and is unique on
// `(code_system, code)`, so every tenant's denial triage reads the same rows.
// PATCH is only `.eq("id", …)`, which the org-scoped client cannot narrow on a
// table with no org_id, so on `requireAdminOnly` alone one tenant editing a
// description, category, recommended action, or `is_terminal` moved every other
// tenant's worklist routing.
describe("platform-global write gate", () => {
  it("rejects a tenant admin who is not a platform admin on POST", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("platform_admin_required");
  });

  it("rejects a tenant admin who is not a platform admin on PATCH", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    const res = await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ isTerminal: true });
    expect(res.status).toBe(403);
  });

  it("never reaches the handler when the gate rejects", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ isTerminal: true });
    expect(supabaseMock.callCount("denial_codes", "update")).toBe(0);
  });

  it("fails closed with 503 when platform membership cannot be verified", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = "unknown";
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(503);
  });

  it("leaves GET open to a tenant admin — the catalog stays readable", async () => {
    stubAdmin();
    mockIsPlatformAdmin.current = false;
    stageSupabaseResponse("denial_codes", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/denial-codes");
    expect(res.status).toBe(200);
  });
});

// ── POST /admin/denial-codes ─────────────────────────────────────────────────

describe("POST /admin/denial-codes — adminRateLimit integration (sensitive preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("denial_codes.create");
  });

  it("calls adminRateLimit with name='denial_codes.create' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "denial_codes.create",
    );
    expect(call).toBeDefined();
    // POST uses the "sensitive" preset (30/hr) — more conservative than "mutation".
    expect(call![0].preset).toBe("sensitive");
  });

  it("passes through and creates denial code when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("denial_codes", "insert", {
      data: { id: CODE_ID },
    });
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CODE_ID);
  });

  it("returns 400 for invalid body", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/denial-codes")
      .send({ code: "CO97" }); // missing required fields
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("uses more conservative 'sensitive' preset vs PATCH 'mutation'", () => {
    const postCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "denial_codes.create",
    );
    const patchCall = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "denial_codes.update",
    );
    expect(postCall![0].preset).toBe("sensitive");
    expect(patchCall![0].preset).toBe("mutation");
    // sensitive (30/hr) is different from mutation (60/hr)
    expect(postCall![0].preset).not.toBe(patchCall![0].preset);
  });
});

// ── PATCH /admin/denial-codes/:id ────────────────────────────────────────────

describe("PATCH /admin/denial-codes/:id — adminRateLimit integration (mutation preset)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ description: "Updated description" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ description: "Updated description" });
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ description: "Updated description" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("denial_codes.update");
  });

  it("calls adminRateLimit with name='denial_codes.update' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "denial_codes.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and updates denial code when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("denial_codes", "update", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/denial-codes/${CODE_ID}`)
      .send({ description: "Updated description" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
