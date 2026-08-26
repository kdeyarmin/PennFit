import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../../lib/resupply/bootstrap-prescriptions.js", () => ({
  previewBootstrapPrescriptions: vi.fn(async () => ({
    mode: "preview",
    eligiblePatients: 2,
    linesPerPatient: 4,
    prescriptionsToCreate: 8,
    lineSkus: ["FILTER-DISP-STD"],
    onlyPacwarePatients: true,
  })),
  commitBootstrapPrescriptions: vi.fn(async () => ({
    mode: "commit",
    eligiblePatients: 2,
    patientsBootstrapped: 2,
    prescriptionsCreated: 8,
    episodesOpened: 8,
    episodeOpenFailures: 0,
    onlyPacwarePatients: true,
  })),
}));

vi.mock("../../middlewares/requireAdmin.js", () => ({
  requireAdmin: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    _req.orgId = "00000000-0000-4000-8000-000000000001";
    _req.adminEmail = "admin@test.local";
    _req.adminUserId = "00000000-0000-4000-8000-000000000099";
    next();
  },
}));

import resupplyBootstrapRouter from "./resupply-bootstrap";

function app(): Express {
  const a = express();
  a.use(express.json());
  a.use("/resupply-api", resupplyBootstrapRouter);
  return a;
}

beforeEach(() => {
  supabaseMock.reset();
  stageSupabaseResponse("audit_log", "insert", { data: null, error: null });
});

describe("POST /admin/resupply/bootstrap-prescriptions", () => {
  it("returns preview counts", async () => {
    const res = await request(app())
      .post("/resupply-api/admin/resupply/bootstrap-prescriptions")
      .send({ mode: "preview" });
    expect(res.status).toBe(200);
    expect(res.body.eligiblePatients).toBe(2);
    expect(res.body.prescriptionsToCreate).toBe(8);
  });

  it("commits bootstrap on request", async () => {
    const res = await request(app())
      .post("/resupply-api/admin/resupply/bootstrap-prescriptions")
      .send({ mode: "commit" });
    expect(res.status).toBe(200);
    expect(res.body.prescriptionsCreated).toBe(8);
  });

  it("400s invalid body", async () => {
    const res = await request(app())
      .post("/resupply-api/admin/resupply/bootstrap-prescriptions")
      .send({ mode: "nope" });
    expect(res.status).toBe(400);
  });
});
