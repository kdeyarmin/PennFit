// Tests for the fit-session review queue's permission wiring and the
// approve/override state guards.
//
// The permission cases run the REAL roleHasPermission via the auth mock,
// so they pin the fix for the review loop's original dead-end: the RT
// (clinician tier) could read the queue but lacked `fit_session.override`,
// while the CSR tier held the permission but could not load the page —
// leaving nobody below admin able to complete a triage.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import fitSessionsRouter from "./fit-sessions";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const MASK_MODEL_ID = "55555555-5555-4555-8555-555555555555";

const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(fitSessionsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("review-queue permissions (real roleHasPermission)", () => {
  it("lets the RT load the queue AND use override — the two halves of one workflow", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("fit_sessions", "select", { data: [] });
    const list = await request(makeApp()).get("/admin/fit-sessions");
    expect(list.status).toBe(200);

    // Override: catalog ownership check → update → event insert.
    stageSupabaseResponse("mask_models", "select", {
      data: { id: MASK_MODEL_ID },
    });
    stageSupabaseResponse("fit_sessions", "update", { data: null });
    stageSupabaseResponse("fit_session_events", "insert", { data: null });
    const res = await request(makeApp())
      .post(`/admin/fit-sessions/${SESSION_ID}/override`)
      .send({
        maskModelId: MASK_MODEL_ID,
        variantId: null,
        reason: "Patient reported a bridge leak at setup.",
      });
    expect(res.status).toBe(200);

    const upd = getSupabaseWritePayloads("fit_sessions", "update")[0] as Record<
      string,
      unknown
    >;
    expect(upd.review_status).toBe("overridden");
    expect(upd.override_reason).toContain("bridge leak");
    // Provenance carries the stable identity, not just a mutable email.
    expect(upd.reviewed_by_user_id).toBe("u_rt");
  });

  it("still refuses override to a role that genuinely lacks it", async () => {
    mockAdmin.current = {
      userId: "u_biller",
      email: "biller@penn.example.com",
      role: "agent",
      granularRole: "biller",
    };
    const res = await request(makeApp())
      .post(`/admin/fit-sessions/${SESSION_ID}/override`)
      .send({
        maskModelId: MASK_MODEL_ID,
        reason: "Should never be allowed to land.",
      });
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/fit-sessions — rescan supersession", () => {
  it("marks a rescan_requested row whose invite has a newer session", async () => {
    mockAdmin.current = RT;
    const OLD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const INVITE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    // The list page.
    stageSupabaseResponse("fit_sessions", "select", {
      data: [
        {
          id: OLD,
          created_at: "2026-08-01T00:00:00.000Z",
          patient_id: null,
          fitter_invite_id: INVITE,
          status: "rescan_required",
          outcome: "low_confidence",
          review_status: "rescan_requested",
          population: "adult",
          service_line: "pap",
          degraded: false,
          primary_recommendation: null,
        },
      ],
    });
    // The sibling lookup that resolves supersession.
    stageSupabaseResponse("fit_sessions", "select", {
      data: [
        {
          id: NEW,
          fitter_invite_id: INVITE,
          created_at: "2026-08-05T00:00:00.000Z",
        },
        {
          id: OLD,
          fitter_invite_id: INVITE,
          created_at: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/fit-sessions?reviewStatus=rescan_requested",
    );
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].supersededBySessionId).toBe(NEW);
  });
});

describe("POST /admin/fit-sessions/:id/approve — state guards", () => {
  it("refuses to approve over an existing override", async () => {
    // An overridden session already carries a decision plus the override
    // mask/reason columns; stamping it "approved" would leave a record
    // that contradicts itself.
    mockAdmin.current = RT;
    stageSupabaseResponse("fit_sessions", "select", {
      data: {
        primary_recommendation: { maskId: MASK_MODEL_ID, name: "Test Mask" },
        outcome: "moderate_confidence",
        review_status: "overridden",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/fit-sessions/${SESSION_ID}/approve`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_overridden");
    expect(getSupabaseWritePayloads("fit_sessions", "update")).toHaveLength(0);
  });

  it("approves a pending session and records the stable reviewer identity", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("fit_sessions", "select", {
      data: {
        primary_recommendation: { maskId: MASK_MODEL_ID, name: "Test Mask" },
        outcome: "moderate_confidence",
        review_status: "pending_review",
      },
    });
    stageSupabaseResponse("fit_sessions", "update", { data: null });
    stageSupabaseResponse("fit_session_events", "insert", { data: null });
    const res = await request(makeApp())
      .post(`/admin/fit-sessions/${SESSION_ID}/approve`)
      .send({});
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads("fit_sessions", "update")[0] as Record<
      string,
      unknown
    >;
    expect(upd.review_status).toBe("approved");
    expect(upd.reviewed_by_user_id).toBe("u_rt");
    expect(upd.reviewed_by_email).toBe("rt@penn.example.com");
  });

  it("still refuses to approve a session with no recommendation", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("fit_sessions", "select", {
      data: {
        primary_recommendation: null,
        outcome: "contraindicated",
        review_status: "pending_review",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/fit-sessions/${SESSION_ID}/approve`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_recommendation_to_approve");
  });
});
