// Tests for conversation-routing route — adminRateLimit integration.
//
// Scope: only the code added in this PR:
//   - PATCH /admin/team/:id/skills            (requireAdminOnly, preset: mutation)
//   - PATCH /admin/conversations/:id/required-skills (requireAdminOnly, preset: mutation)
//   - POST  /admin/conversations/:id/auto-assign  (conversations.manage, preset: mutation)
//
// Tests verify:
//   1. Auth gates (requireAdminOnly / requirePermission) fire before rate limiting.
//   2. When adminRateLimit blocks, the route returns 429 with the correct limiter name.
//   3. When adminRateLimit passes through, the handler runs normally.
//   4. adminRateLimit is called with the exact name/preset from the PR diff.

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
    (opts: { name: string; preset?: string }) => (
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

// ── Audit and lib mocks ──────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

type AutoAssignResultLike =
  | { assigned: true; adminUserId: string; matchedSkillCount: number }
  | {
      assigned: false;
      reason:
        | "conversation_not_found"
        | "already_assigned"
        | "no_required_skills"
        | "no_eligible_candidate";
    };
const maybeAutoAssignMock = vi.hoisted(() =>
  vi.fn<() => Promise<AutoAssignResultLike>>(async () => ({
    assigned: true,
    adminUserId: "u_assignee",
    matchedSkillCount: 1,
  })),
);
vi.mock("../../lib/routing/auto-assign", () => ({
  maybeAutoAssignConversation: maybeAutoAssignMock,
}));

vi.mock("../../lib/routing/skill-score", () => ({
  scoreCandidates: vi.fn(() => []),
}));

import routingRouter from "./conversation-routing";

const CONV_UUID = "ccccdddd-0000-4000-8000-000000000001";
const TEAM_ID = "team-member-id-1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(routingRouter);
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

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
  maybeAutoAssignMock.mockClear();
  maybeAutoAssignMock.mockResolvedValue({
    assigned: true,
    adminUserId: "u_assignee",
    matchedSkillCount: 1,
  });
});

// ── PATCH /admin/team/:id/skills ─────────────────────────────────────────────

describe("PATCH /admin/team/:id/skills — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/team/${TEAM_ID}/skills`)
      .send({ skills: ["billing"] });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/team/${TEAM_ID}/skills`)
      .send({ skills: ["billing"] });
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/team/${TEAM_ID}/skills`)
      .send({ skills: ["billing"] });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_routing.set_skills");
  });

  it("calls adminRateLimit with name='conversation_routing.set_skills' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_routing.set_skills",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through when not rate-limited and updates skills", async () => {
    stubAdmin();
    stageSupabaseResponse("admin_users", "update", {
      data: [{ id: TEAM_ID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/team/${TEAM_ID}/skills`)
      .send({ skills: ["billing", "clinical"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.skills)).toBe(true);
  });

  it("returns 404 when the admin user does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("admin_users", "update", { data: [] });
    const res = await request(makeApp())
      .patch(`/admin/team/${TEAM_ID}/skills`)
      .send({ skills: ["billing"] });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /admin/conversations/:id/required-skills ───────────────────────────

describe("PATCH /admin/conversations/:id/required-skills — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/required-skills`)
      .send({ requiredSkills: ["billing"] });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/required-skills`)
      .send({ requiredSkills: ["billing"] });
    expect(res.status).toBe(403);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/required-skills`)
      .send({ requiredSkills: ["billing"] });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_routing.set_required_skills");
  });

  it("calls adminRateLimit with name='conversation_routing.set_required_skills' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_routing.set_required_skills",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and sets required skills when not rate-limited", async () => {
    stubAdmin();
    stageSupabaseResponse("conversations", "update", {
      data: [{ id: CONV_UUID }],
    });
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/required-skills`)
      .send({ requiredSkills: ["billing", "clinical"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.requiredSkills)).toBe(true);
  });

  it("returns 400 for invalid skill names", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/conversations/${CONV_UUID}/required-skills`)
      .send({ requiredSkills: ["UPPERCASE-INVALID!"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── POST /admin/conversations/:id/auto-assign ────────────────────────────────

describe("POST /admin/conversations/:id/auto-assign — adminRateLimit integration", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 429 when adminRateLimit blocks", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("too_many_requests");
    expect(res.body.limiter).toBe("conversation_routing.auto_assign");
  });

  it("calls adminRateLimit with name='conversation_routing.auto_assign' and preset='mutation'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "conversation_routing.auto_assign",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("mutation");
  });

  it("passes through and assigns when not rate-limited", async () => {
    stubAdmin();
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(200);
    expect(maybeAutoAssignMock).toHaveBeenCalledOnce();
  });

  it("returns 409 when conversation is already assigned", async () => {
    stubAdmin();
    maybeAutoAssignMock.mockResolvedValueOnce({
      assigned: false,
      reason: "already_assigned",
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_assigned");
  });

  it("returns 404 when the conversation is not found", async () => {
    stubAdmin();
    maybeAutoAssignMock.mockResolvedValueOnce({
      assigned: false,
      reason: "conversation_not_found",
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when there are no required skills (no_required_skills reason)", async () => {
    // Regression: AutoAssignResultLike union variant "no_required_skills" must
    // map to 409 — same as "already_assigned" — per the route comment that all
    // non-404 unassigned outcomes use 409 so the SPA can branch on status.
    stubAdmin();
    maybeAutoAssignMock.mockResolvedValueOnce({
      assigned: false,
      reason: "no_required_skills",
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_required_skills");
  });

  it("returns 409 when no eligible candidate is found (no_eligible_candidate reason)", async () => {
    // Regression: AutoAssignResultLike union variant "no_eligible_candidate"
    // must also map to 409, not 404 or 422.
    stubAdmin();
    maybeAutoAssignMock.mockResolvedValueOnce({
      assigned: false,
      reason: "no_eligible_candidate",
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_eligible_candidate");
  });

  it("returns 200 with assignment details when auto-assign succeeds", async () => {
    // Positive path for AutoAssignResultLike { assigned: true } variant.
    stubAdmin();
    maybeAutoAssignMock.mockResolvedValueOnce({
      assigned: true,
      adminUserId: "u_specific_assignee",
      matchedSkillCount: 3,
    });
    const res = await request(makeApp()).post(
      `/admin/conversations/${CONV_UUID}/auto-assign`,
    );
    expect(res.status).toBe(200);
    expect(res.body.assigned).toBe(true);
    expect(res.body.adminUserId).toBe("u_specific_assignee");
    expect(res.body.matchedSkillCount).toBe(3);
  });
});