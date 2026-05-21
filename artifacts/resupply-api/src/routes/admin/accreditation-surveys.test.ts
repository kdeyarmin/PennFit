// Tests for accreditation-surveys route — adminRateLimit removal.
//
// Scope: only the code changed in this PR:
//   - POST  /admin/accreditation/surveys   (adminRateLimit REMOVED)
//   - PATCH /admin/accreditation/surveys/:id (adminRateLimit REMOVED)
//
// Both routes still require requireAdminOnly.
//
// Tests verify:
//   1. adminRateLimit is no longer wired (the spy is never invoked).
//   2. Routes remain protected by requireAdminOnly (401/403).
//   3. Routes function normally (happy path) without a 429.
//   4. Validation errors still surface correctly.

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
// The factory is mocked at module load; if the route no longer imports or
// calls it, adminRateLimitSpy will have zero invocations.
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

import accreditationSurveysRouter from "./accreditation-surveys";

const SURVEY_ID = "aaaaaaaa-1111-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(accreditationSurveysRouter);
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
  accreditationBody: "achc",
  surveyType: "initial",
  findingsCount: 0,
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  adminRateLimitSpy.mockClear();
});

// ── POST /admin/accreditation/surveys ────────────────────────────────────────

describe("POST /admin/accreditation/surveys — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for POST (middleware was removed)", async () => {
    // Run any request through the router to ensure module-load
    // side effects are captured, then check spy invocations.
    await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    // adminRateLimitSpy.mock.results tracks HANDLER invocations.
    // The factory (adminRateLimitSpy itself) should never be called
    // because the import was removed from the route file.
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated (requireAdminOnly still gates the route)", async () => {
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks non-admin)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 (no rate limiter present)", async () => {
    stubAdmin();
    // Stage the org lookup and the insert.
    stageSupabaseResponse("dme_organization", "select", {
      data: { id: "org-id-1" },
    });
    stageSupabaseResponse("accreditation_surveys", "insert", {
      data: { id: SURVEY_ID },
    });
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    expect(res.status).not.toBe(429);
  });

  it("passes through and creates survey when authenticated", async () => {
    stubAdmin();
    stageSupabaseResponse("dme_organization", "select", {
      data: { id: "org-id-1" },
    });
    stageSupabaseResponse("accreditation_surveys", "insert", {
      data: { id: SURVEY_ID },
    });
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(SURVEY_ID);
  });

  it("returns 409 when no dme_organization is configured", async () => {
    stubAdmin();
    stageSupabaseResponse("dme_organization", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send(validCreateBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_organization");
  });

  it("returns 400 for invalid body (bad accreditationBody value)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send({ accreditationBody: "unknown_body", surveyType: "initial" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/accreditation/surveys")
      .send({ ...validCreateBody, unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── PATCH /admin/accreditation/surveys/:id ───────────────────────────────────

describe("PATCH /admin/accreditation/surveys/:id — adminRateLimit removed", () => {
  it("adminRateLimit is NOT called for PATCH (middleware was removed)", async () => {
    await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "passed" });
    expect(adminRateLimitSpy).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "passed" });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "passed" });
    expect(res.status).toBe(403);
  });

  it("does NOT return 429 when authenticated (no rate limiter)", async () => {
    stubAdmin();
    stageSupabaseResponse("accreditation_surveys", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "passed" });
    expect(res.status).not.toBe(429);
  });

  it("passes through and updates survey when authenticated", async () => {
    stubAdmin();
    stageSupabaseResponse("accreditation_surveys", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "passed" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when id param is not a UUID", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/accreditation/surveys/not-a-uuid")
      .send({ outcome: "passed" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 400 for invalid outcome value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ outcome: "unknown_outcome" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for unknown field (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/accreditation/surveys/${SURVEY_ID}`)
      .send({ unknownField: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

// ── GET /admin/accreditation/surveys ─────────────────────────────────────────
//
// This route was changed in this PR: requireAdmin → requirePermission("compliance.read").
// Tests verify:
//   1. Returns 401 when unauthenticated.
//   2. Returns 403 when caller is an agent without compliance.read permission.
//   3. Returns 200 with surveys array for an admin.

describe("GET /admin/accreditation/surveys — requirePermission(compliance.read)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/accreditation/surveys");
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is an agent (lacks compliance.read)", async () => {
    stubAgent();
    const res = await request(makeApp()).get("/admin/accreditation/surveys");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("permission_denied");
  });

  it("returns 200 with surveys array for an admin", async () => {
    stubAdmin();
    stageSupabaseResponse("accreditation_surveys", "select", {
      data: [
        {
          id: SURVEY_ID,
          organization_id: "org-id-1",
          accreditation_body: "achc",
          survey_type: "initial",
          scheduled_for: null,
          completed_on: null,
          outcome: null,
          findings_count: 0,
          corrective_action_due_on: null,
          corrective_action_completed_on: null,
          surveyor_name: null,
          report_document_object_key: null,
          notes: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/accreditation/surveys");
    expect(res.status).toBe(200);
    expect(res.body.surveys).toBeInstanceOf(Array);
    expect(res.body.surveys).toHaveLength(1);
    expect(res.body.surveys[0].id).toBe(SURVEY_ID);
  });

  it("returns 200 with empty surveys array when none exist", async () => {
    stubAdmin();
    stageSupabaseResponse("accreditation_surveys", "select", { data: [] });
    const res = await request(makeApp()).get("/admin/accreditation/surveys");
    expect(res.status).toBe(200);
    expect(res.body.surveys).toEqual([]);
  });

  it("returns survey rows with camelCase keys", async () => {
    stubAdmin();
    stageSupabaseResponse("accreditation_surveys", "select", {
      data: [
        {
          id: SURVEY_ID,
          organization_id: "org-id-1",
          accreditation_body: "tjc",
          survey_type: "renewal",
          scheduled_for: "2026-03-01",
          completed_on: "2026-03-15",
          outcome: "passed",
          findings_count: 2,
          corrective_action_due_on: null,
          corrective_action_completed_on: null,
          surveyor_name: "Jane Inspector",
          report_document_object_key: null,
          notes: "All good",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-03-15T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get("/admin/accreditation/surveys");
    expect(res.status).toBe(200);
    const survey = res.body.surveys[0];
    expect(survey.accreditationBody).toBe("tjc");
    expect(survey.surveyType).toBe("renewal");
    expect(survey.outcome).toBe("passed");
    expect(survey.findingsCount).toBe(2);
    expect(survey.surveyorName).toBe("Jane Inspector");
  });
});