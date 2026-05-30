// Route tests for /shop/me/maintenance.
//
// Coverage:
//   * 401 without a session
//   * empty response when patient email isn't linked (anonymous OR
//     ambiguous match)
//   * GET returns the catalog with bucketing applied to a known
//     last-completion
//   * POST validates the task key (404 on unknown)
//   * POST inserts + returns the new row id

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as MockSignedInProfile | string | null,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import meMaintenanceRouter from "./me-maintenance";

const PATIENT_ID = "11111111-1111-1111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(meMaintenanceRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("GET /shop/me/maintenance", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get("/shop/me/maintenance");
    expect(res.status).toBe(401);
  });

  it("returns empty + patientLinked:false when email isn't set", async () => {
    mockSignedIn.current = { customerId: "c_1" };
    const res = await request(makeApp()).get("/shop/me/maintenance");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
    expect(res.body.tasks).toEqual([]);
  });

  it("returns empty + patientLinked:false when patient lookup finds zero matches", async () => {
    mockSignedIn.current = {
      customerId: "c_1",
      email: "shopper@penn.example.com",
    };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).get("/shop/me/maintenance");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(false);
  });

  it("decorates each task with bucket + nextDueDate from completion log", async () => {
    mockSignedIn.current = {
      customerId: "c_1",
      email: "patient@penn.example.com",
    };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }],
    });
    // 8 days ago — past weekly cadence → due_now for weekly tasks.
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    stageSupabaseResponse("patient_maintenance_log", "select", {
      data: [{ task_key: "tubing_wash", completed_at: eightDaysAgo }],
    });

    const res = await request(makeApp()).get("/shop/me/maintenance");
    expect(res.status).toBe(200);
    expect(res.body.patientLinked).toBe(true);
    expect(res.body.tasks).toHaveLength(5);

    const tubing = res.body.tasks.find(
      (t: { key: string }) => t.key === "tubing_wash",
    );
    expect(tubing.lastCompletedAt).toBe(eightDaysAgo);
    expect(tubing.bucket).toBe("due_now");

    // A task that's never been completed bucketizes as due_now too.
    const mask = res.body.tasks.find(
      (t: { key: string }) => t.key === "mask_wash",
    );
    expect(mask.lastCompletedAt).toBeNull();
    expect(mask.bucket).toBe("due_now");
  });
});

describe("POST /shop/me/maintenance/:taskKey/log", () => {
  it("404s for an unknown task key", async () => {
    mockSignedIn.current = {
      customerId: "c_1",
      email: "patient@penn.example.com",
    };
    const res = await request(makeApp()).post(
      "/shop/me/maintenance/not_real/log",
    );
    expect(res.status).toBe(404);
  });

  it("403s when the email isn't linked to a patient", async () => {
    mockSignedIn.current = {
      customerId: "c_1",
      email: "no-match@penn.example.com",
    };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).post(
      "/shop/me/maintenance/mask_wash/log",
    );
    expect(res.status).toBe(403);
  });

  it("inserts a completion row and returns the new id", async () => {
    mockSignedIn.current = {
      customerId: "c_1",
      email: "patient@penn.example.com",
    };
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }],
    });
    stageSupabaseResponse("patient_maintenance_log", "insert", {
      data: {
        id: "log_new",
        completed_at: "2026-05-12T10:00:00Z",
      },
    });
    const res = await request(makeApp()).post(
      "/shop/me/maintenance/mask_wash/log",
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("log_new");
    expect(res.body.taskKey).toBe("mask_wash");
  });
});
