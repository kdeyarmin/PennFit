// Tests for /admin/analytics/rt-outcomes (RT #24) — the pure per-author
// rollup + the HTTP route's gate and aggregate shape.

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

import rtOutcomesRouter, {
  buildRtOutcomes,
  type EncounterRow,
} from "./rt-outcomes";

// admin holds clinical.read → 200.
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
// rt (clinician) holds clinical.read → 200.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
// csr lacks clinical.read → 403.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(rtOutcomesRouter);
  return app;
}

function row(over: Partial<EncounterRow>): EncounterRow {
  return {
    author_user_id: "u1",
    author_email: "rt-a@penn.example.com",
    encounter_type: "troubleshoot",
    patient_id: "p1",
    follow_up_at: null,
    created_at: "2026-05-20T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildRtOutcomes (pure)", () => {
  it("groups by author and counts encounters, distinct patients, follow-ups, interventions", () => {
    const report = buildRtOutcomes(
      [
        row({ author_email: "a@x.com", patient_id: "p1" }),
        row({
          author_email: "a@x.com",
          patient_id: "p1", // same patient — distinct count stays 1
          encounter_type: "adherence_intervention",
          follow_up_at: "2026-06-10T00:00:00.000Z",
          created_at: "2026-05-25T00:00:00.000Z", // newest for this author
        }),
        row({ author_email: "a@x.com", patient_id: "p2" }),
        row({
          author_email: "b@x.com",
          patient_id: "p3",
          encounter_type: "mask_fit",
        }),
      ],
      90,
    );

    expect(report.totals).toEqual({
      encounters: 4,
      rts: 2,
      patientsManaged: 3, // p1, p2, p3 distinct globally
      followUpsCommitted: 1,
      interventions: 1,
    });

    // Most-active author first.
    const a = report.rows[0];
    expect(a.authorEmail).toBe("a@x.com");
    expect(a.encountersTotal).toBe(3);
    expect(a.patientsManaged).toBe(2);
    expect(a.followUpsCommitted).toBe(1);
    expect(a.interventions).toBe(1);
    expect(a.byType.adherence_intervention).toBe(1);
    expect(a.byType.troubleshoot).toBe(2);
    expect(a.lastActiveAt).toBe("2026-05-25T00:00:00.000Z"); // max created_at
  });

  it("buckets an unknown encounter_type as 'other' and tolerates a null author id", () => {
    const report = buildRtOutcomes(
      [
        row({
          author_email: "c@x.com",
          author_user_id: null,
          encounter_type: "totally_made_up",
        }),
      ],
      30,
    );
    expect(report.rows[0].byType.other).toBe(1);
    expect(report.rows[0].authorUserId).toBe(null);
    expect(report.windowDays).toBe(30);
  });
});

describe("GET /admin/analytics/rt-outcomes", () => {
  it("401s without admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/analytics/rt-outcomes")).status,
    ).toBe(401);
  });

  it("403s for a role without clinical.read (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/analytics/rt-outcomes");
    expect(res.status).toBe(403);
  });

  it("returns the per-RT rollup for a clinician", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        row({ author_email: "rt-a@x.com", patient_id: "p1" }),
        row({ author_email: "rt-a@x.com", patient_id: "p2" }),
        row({ author_email: "rt-b@x.com", patient_id: "p3" }),
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/analytics/rt-outcomes?windowDays=45",
    );
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(45);
    expect(res.body.totals.encounters).toBe(3);
    expect(res.body.totals.rts).toBe(2);
    expect(res.body.rows[0].authorEmail).toBe("rt-a@x.com"); // most active
    expect(res.body.rows[0].encountersTotal).toBe(2);
  });

  it("400s on a bad windowDays", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/analytics/rt-outcomes?windowDays=9999",
    );
    expect(res.status).toBe(400);
  });
});
