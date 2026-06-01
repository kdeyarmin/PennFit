// Tests for the RT mask-fit triage worklist (RT #22a slice 2): the pure
// severity ranker + the route gates/wiring.

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

import maskFitWorklistRouter, {
  rankMaskFitWorklist,
} from "./mask-fit-worklist";

const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(maskFitWorklistRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("rankMaskFitWorklist (pure)", () => {
  it("orders uncomfortable > leaking, then newest first", () => {
    const ranked = rankMaskFitWorklist([
      { fit_outcome: "leaking", created_at: "2026-05-01T00:00:00Z" },
      { fit_outcome: "uncomfortable", created_at: "2026-05-01T00:00:00Z" },
      { fit_outcome: "leaking", created_at: "2026-05-03T00:00:00Z" },
    ]);
    expect(
      ranked.map((r) => `${r.fit_outcome}@${r.created_at.slice(8, 10)}`),
    ).toEqual(["uncomfortable@01", "leaking@03", "leaking@01"]);
  });
});

describe("GET /admin/clinical/mask-fit/worklist", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/clinical/mask-fit/worklist",
    );
    expect(res.status).toBe(401);
  });

  it("returns ranked items with patient ids resolved from the order", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("mask_fit_outcomes", "select", {
      data: [
        {
          id: "mfo-1",
          order_id: "order-1",
          fit_outcome: "leaking",
          comment: null,
          status: "new",
          created_at: "2026-05-01T00:00:00Z",
        },
        {
          id: "mfo-2",
          order_id: "order-2",
          fit_outcome: "uncomfortable",
          comment: "hurts",
          status: "new",
          created_at: "2026-05-02T00:00:00Z",
        },
      ],
      error: null,
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: [
        { id: "order-1", patient_id: "pat-1" },
        { id: "order-2", patient_id: "pat-2" },
      ],
      error: null,
    });

    const res = await request(makeApp()).get(
      "/admin/clinical/mask-fit/worklist",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.items[0].fit_outcome).toBe("uncomfortable"); // worst first
    expect(res.body.items[0].patientId).toBe("pat-2");
    expect(res.body.counts).toEqual({ uncomfortable: 1, leaking: 1 });
  });
});

describe("POST /admin/clinical/mask-fit/:id/triage", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("updates the triage status", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("mask_fit_outcomes", "update", {
      data: { id: ID },
      error: null,
    });
    const res = await request(makeApp())
      .post(`/admin/clinical/mask-fit/${ID}/triage`)
      .send({ status: "actioned" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("actioned");
  });

  it("400s an invalid status", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(`/admin/clinical/mask-fit/${ID}/triage`)
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
  });
});
