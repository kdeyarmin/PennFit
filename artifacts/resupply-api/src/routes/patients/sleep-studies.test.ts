import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

import sleepStudiesRouter from "./sleep-studies";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(sleepStudiesRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = {
    userId: "admin-1",
    email: "admin@example.com",
    role: "admin",
  };
});

describe("POST /patients/:id/sleep-studies", () => {
  it("returns 500 instead of a false 404 when patient lookup fails", async () => {
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    });

    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/sleep-studies`)
      .send({
        studyDate: "2026-08-20",
        studyType: "psg",
        ahi: 12.5,
      });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "query_failed" });
  });
});
