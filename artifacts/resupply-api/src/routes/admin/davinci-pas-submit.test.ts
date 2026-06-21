// Tests for the davinci-pas-submit route's pre-submit guards added in this
// PR: a PAS request must carry a diagnosis (resolved from the patient's
// sleep study) — submission is blocked 409 when none is on file — and the
// optional quantity body override is validated. The full payer-transport
// happy path is exercised by the build-bundle unit tests; here we cover the
// guards that short-circuit BEFORE any payer call.

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

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import davinciPasSubmitRouter from "./davinci-pas-submit";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const PA_ID = "22222222-2222-4222-8222-222222222222";
const url = `/admin/patients/${PATIENT_ID}/prior-authorizations/${PA_ID}/submit-davinci-pas`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(davinciPasSubmitRouter);
  return app;
}

function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin",
    email: "biller@example.com",
    role: "admin",
  };
}

function stagePaWithCoverage() {
  stageSupabaseResponse("prior_authorizations", "select", {
    data: {
      id: PA_ID,
      patient_id: PATIENT_ID,
      insurance_coverage_id: "cov-1",
      hcpcs_code: "E0601",
      payer_name: "Aetna",
      status: "draft",
    },
  });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("POST submit-davinci-pas — pre-submit guards", () => {
  it("401 unauthenticated", async () => {
    expect((await request(makeApp()).post(url).send({})).status).toBe(401);
  });

  it("400 for an invalid quantity (must be a positive integer)", async () => {
    stubAdmin();
    const res = await request(makeApp()).post(url).send({ quantity: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("404 when the PA does not exist", async () => {
    stubAdmin();
    stageSupabaseResponse("prior_authorizations", "select", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("prior_auth_not_found");
  });

  it("409 no_diagnosis_on_file when the patient has no sleep-study diagnosis", async () => {
    stubAdmin();
    stagePaWithCoverage();
    stageSupabaseResponse("sleep_studies", "select", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_diagnosis_on_file");
  });
});
