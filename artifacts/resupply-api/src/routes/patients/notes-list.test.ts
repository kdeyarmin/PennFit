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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

import notesListRouter from "./notes-list";
import notesCreateRouter from "./notes-create";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", notesListRouter);
  app.use("/resupply-api", notesCreateRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
  mockAdmin.current = {
    userId: "admin-1",
    email: "admin@example.com",
    role: "admin",
  };
});

describe("POST /patients/:id/notes", () => {
  it("returns a server error rather than a false 404 when patient lookup fails", async () => {
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    });

    const res = await request(makeApp())
      .post(`/resupply-api/patients/${PATIENT_ID}/notes`)
      .send({ body: "Follow-up note" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "query_failed" });
  });
});

describe("GET /patients/:id/notes", () => {
  it("returns a server error rather than a false 404 when patient lookup fails", async () => {
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/notes`,
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "query_failed" });
  });

  it("does not expose database error details when the notes query fails", async () => {
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_notes", "select", {
      data: null,
      error: {
        code: "XX000",
        message: "secret schema and connection details",
      },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/patients/${PATIENT_ID}/notes`,
    );

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "query_failed" });
    expect(JSON.stringify(res.body)).not.toContain("secret schema");
  });
});
