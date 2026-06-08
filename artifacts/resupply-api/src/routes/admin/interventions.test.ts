// Tests for RT #21 interventions — the pure worklist sort + the three
// routes' gates and wiring.

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

import interventionsRouter, {
  buildInterventionWorklist,
  computeOutcomeMeasurement,
  type InterventionRow,
  type TherapyNightInput,
} from "./interventions";

// rt (clinician) holds clinical.read + clinical.intervention.write.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
// csr lacks the clinical perms → 403.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const PATIENT_ID = "patient_1";
const ENC_ID = "enc_1";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(interventionsRouter);
  return app;
}

function row(over: Partial<InterventionRow>): InterventionRow {
  return {
    id: "i1",
    patient_id: PATIENT_ID,
    assessment_category: "mask_leak",
    outcome_status: "pending",
    reason: null,
    plan: null,
    follow_up_at: null,
    author_email: "rt@penn.example.com",
    created_at: "2026-05-20T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("buildInterventionWorklist (pure)", () => {
  it("puts open (pending) items first, soonest follow-up first", () => {
    const items = buildInterventionWorklist([
      row({
        id: "resolved",
        outcome_status: "improved",
        created_at: "2026-05-25T00:00:00.000Z",
      }),
      row({
        id: "open_later",
        outcome_status: "pending",
        follow_up_at: "2026-06-10T00:00:00.000Z",
      }),
      row({
        id: "open_sooner",
        outcome_status: "pending",
        follow_up_at: "2026-06-01T00:00:00.000Z",
      }),
    ]);
    expect(items.map((i) => i.id)).toEqual([
      "open_sooner",
      "open_later",
      "resolved",
    ]);
    expect(items[0].open).toBe(true);
    expect(items[2].open).toBe(false);
  });

  it("treats a null outcome_status as pending/open", () => {
    const items = buildInterventionWorklist([
      row({ id: "x", outcome_status: null }),
    ]);
    expect(items[0].outcomeStatus).toBe("pending");
    expect(items[0].open).toBe(true);
  });
});

describe("POST /admin/patients/:id/interventions", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "mask_leak" });
    expect(res.status).toBe(401);
  });

  it("403s for a role without clinical.intervention.write (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "mask_leak" });
    expect(res.status).toBe(403);
  });

  it("400s on an invalid assessment category", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({ assessmentCategory: "bogus" });
    expect(res.status).toBe(400);
  });

  it("creates an adherence_intervention seeded to pending", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "insert", {
      data: { id: ENC_ID, created_at: "2026-05-20T00:00:00.000Z" },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/interventions`)
      .send({
        assessmentCategory: "claustrophobia",
        plan: "Trial a nasal pillow mask; coach on desensitization.",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: ENC_ID, outcomeStatus: "pending" });
  });
});

describe("GET /admin/clinical/interventions", () => {
  it("403s for csr", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get("/admin/clinical/interventions");
    expect(res.status).toBe(403);
  });

  it("returns the worklist with an open count", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: [
        row({ id: "a", outcome_status: "pending" }),
        row({ id: "b", outcome_status: "improved" }),
      ],
    });
    const res = await request(makeApp()).get("/admin/clinical/interventions");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.openCount).toBe(1);
    expect(res.body.interventions[0].id).toBe("a"); // open first
  });
});

describe("PATCH /admin/interventions/:id/outcome", () => {
  it("403s for csr", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(403);
  });

  it("400s on an invalid outcome", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "bogus" });
    expect(res.status).toBe(400);
  });

  it("404s when the intervention doesn't exist", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(404);
  });

  it("records the outcome", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "update", {
      data: { id: ENC_ID, outcome_status: "improved" },
    });
    const res = await request(makeApp())
      .patch(`/admin/interventions/${ENC_ID}/outcome`)
      .send({ outcomeStatus: "improved" });
    expect(res.status).toBe(200);
    expect(res.body.outcomeStatus).toBe("improved");
  });
});

describe("computeOutcomeMeasurement (pure)", () => {
  function night(over: Partial<TherapyNightInput>): TherapyNightInput {
    return {
      nightDate: "2026-05-01",
      usageMinutes: 300,
      ahi: 3,
      leakLMin: 10,
      ...over,
    };
  }

  it("flags `improved` when avg nightly usage rises ≥ 30 min after the anchor", () => {
    const m = computeOutcomeMeasurement({
      anchorDate: "2026-05-15",
      nights: [
        // before: ~200 min/night, none compliant
        night({ nightDate: "2026-05-10", usageMinutes: 200 }),
        night({ nightDate: "2026-05-11", usageMinutes: 210 }),
        night({ nightDate: "2026-05-12", usageMinutes: 190 }),
        // after: ~310 min/night, all compliant
        night({ nightDate: "2026-05-16", usageMinutes: 300 }),
        night({ nightDate: "2026-05-17", usageMinutes: 320 }),
        night({ nightDate: "2026-05-18", usageMinutes: 310 }),
      ],
    });
    expect(m.signal).toBe("improved");
    expect(m.before.nights).toBe(3);
    expect(m.after.nights).toBe(3);
    expect(m.before.compliantNights).toBe(0);
    expect(m.after.compliantNights).toBe(3);
    expect(m.after.complianceRatePct).toBe(100);
    expect(m.deltas.usageMinutes).toBeGreaterThanOrEqual(30);
  });

  it("flags `worsened` when usage drops and `no_change` when flat", () => {
    const worse = computeOutcomeMeasurement({
      anchorDate: "2026-05-15",
      nights: [
        night({ nightDate: "2026-05-12", usageMinutes: 320 }),
        night({ nightDate: "2026-05-13", usageMinutes: 330 }),
        night({ nightDate: "2026-05-14", usageMinutes: 310 }),
        night({ nightDate: "2026-05-16", usageMinutes: 200 }),
        night({ nightDate: "2026-05-17", usageMinutes: 210 }),
        night({ nightDate: "2026-05-18", usageMinutes: 220 }),
      ],
    });
    expect(worse.signal).toBe("worsened");

    const flat = computeOutcomeMeasurement({
      anchorDate: "2026-05-15",
      nights: [
        night({ nightDate: "2026-05-12", usageMinutes: 300 }),
        night({ nightDate: "2026-05-13", usageMinutes: 305 }),
        night({ nightDate: "2026-05-14", usageMinutes: 295 }),
        night({ nightDate: "2026-05-16", usageMinutes: 300 }),
        night({ nightDate: "2026-05-17", usageMinutes: 310 }),
        night({ nightDate: "2026-05-18", usageMinutes: 290 }),
      ],
    });
    expect(flat.signal).toBe("no_change");
  });

  it("returns `insufficient_data` when either side has too few usage nights", () => {
    const m = computeOutcomeMeasurement({
      anchorDate: "2026-05-15",
      nights: [
        night({ nightDate: "2026-05-14", usageMinutes: 300 }),
        night({ nightDate: "2026-05-16", usageMinutes: 300 }),
        night({ nightDate: "2026-05-17", usageMinutes: 300 }),
        night({ nightDate: "2026-05-18", usageMinutes: 300 }),
      ],
    });
    expect(m.signal).toBe("insufficient_data");
    expect(m.before.nightsWithUsage).toBe(1);
  });

  it("dedups duplicate night dates (multi-cloud sync) and ignores null usage in averages", () => {
    const m = computeOutcomeMeasurement({
      anchorDate: "2026-05-15",
      nights: [
        night({ nightDate: "2026-05-16", usageMinutes: 300 }),
        night({ nightDate: "2026-05-16", usageMinutes: 999 }), // dup date — dropped
        night({ nightDate: "2026-05-17", usageMinutes: null }), // counted as a night, not in usage avg
      ],
    });
    expect(m.after.nights).toBe(2);
    expect(m.after.nightsWithUsage).toBe(1);
    expect(m.after.avgUsageMinutes).toBe(300);
  });
});

describe("GET /admin/interventions/:id/outcome-measurement", () => {
  it("403s for csr", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get(
      `/admin/interventions/${ENC_ID}/outcome-measurement`,
    );
    expect(res.status).toBe(403);
  });

  it("404s when the intervention doesn't exist", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/interventions/${ENC_ID}/outcome-measurement`,
    );
    expect(res.status).toBe(404);
  });

  it("returns the before/after measurement for a real intervention", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("clinical_encounters", "select", {
      data: {
        id: ENC_ID,
        patient_id: PATIENT_ID,
        created_at: "2026-05-15T12:00:00.000Z",
        assessment_category: "mask_leak",
        outcome_status: "pending",
      },
    });
    stageSupabaseResponse("patient_therapy_nights", "select", {
      data: [
        {
          night_date: "2026-05-10",
          usage_minutes: 200,
          ahi: 5,
          leak_rate_l_min: 30,
        },
        {
          night_date: "2026-05-11",
          usage_minutes: 210,
          ahi: 5,
          leak_rate_l_min: 28,
        },
        {
          night_date: "2026-05-12",
          usage_minutes: 190,
          ahi: 6,
          leak_rate_l_min: 32,
        },
        {
          night_date: "2026-05-16",
          usage_minutes: 300,
          ahi: 3,
          leak_rate_l_min: 12,
        },
        {
          night_date: "2026-05-17",
          usage_minutes: 320,
          ahi: 3,
          leak_rate_l_min: 10,
        },
        {
          night_date: "2026-05-18",
          usage_minutes: 310,
          ahi: 2,
          leak_rate_l_min: 11,
        },
      ],
    });
    const res = await request(makeApp()).get(
      `/admin/interventions/${ENC_ID}/outcome-measurement`,
    );
    expect(res.status).toBe(200);
    expect(res.body.interventionId).toBe(ENC_ID);
    expect(res.body.patientId).toBe(PATIENT_ID);
    expect(res.body.anchorDate).toBe("2026-05-15");
    expect(res.body.signal).toBe("improved");
    expect(res.body.after.compliantNights).toBe(3);
    // Leak improved (dropped) after the mask-leak intervention.
    expect(res.body.deltas.leak).toBeLessThan(0);
  });
});
