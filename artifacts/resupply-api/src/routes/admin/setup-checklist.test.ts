// Route tests for /admin/patients/:patientId/setup-checklist (RT #27).

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
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import setupChecklistRouter from "./setup-checklist";

const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const PATIENT_ID = "pat_1";
const BASE = `/admin/patients/${PATIENT_ID}/setup-checklist`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(setupChecklistRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET setup-checklist", () => {
  it("401s without admin", async () => {
    expect((await request(makeApp()).get(BASE)).status).toBe(401);
  });

  it("403s for the CSR tier (lacks clinical.read)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get(BASE);
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("clinical.read");
  });

  it("returns the canonical steps merged with recorded status", async () => {
    mockAdmin.current = RT;
    stageSupabaseResponse("setup_checklist_items", "select", {
      data: [
        {
          step_key: "humidifier",
          status: "done",
          note: null,
          completed_by_email: "rt@penn.example.com",
          completed_at: "2026-05-31T10:00:00Z",
          updated_at: "2026-05-31T10:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(6);
    const byKey = Object.fromEntries(
      res.body.steps.map((s: { stepKey: string; status: string }) => [
        s.stepKey,
        s.status,
      ]),
    );
    expect(byKey.humidifier).toBe("done");
    expect(byKey.mask_fit_seal).toBe("pending"); // unrecorded → default
  });
});

describe("PUT setup-checklist/:stepKey", () => {
  it("403s for the CSR tier (lacks clinical.note.write)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .put(`${BASE}/humidifier`)
      .send({ status: "done" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("setup_checklist_items", "upsert")).toBe(0);
  });

  it("400s on an unknown step key", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .put(`${BASE}/bogus_step`)
      .send({ status: "done" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_step_key");
  });

  it("400s on an invalid status", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .put(`${BASE}/humidifier`)
      .send({ status: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("upserts a step (done stamps completed_at) + audits structurally", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .put(`${BASE}/humidifier`)
      .send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stepKey: "humidifier", status: "done" });

    const payload = getSupabaseWritePayloads(
      "setup_checklist_items",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      patient_id: PATIENT_ID,
      step_key: "humidifier",
      status: "done",
      completed_by_email: "rt@penn.example.com",
    });
    expect(typeof payload.completed_at).toBe("string");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("setup_checklist.upsert");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      step_key: "humidifier",
      status: "done",
    });
  });
});
