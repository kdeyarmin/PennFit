// Route tests for /admin/prior-authorizations/:id/draft-renewal (Biller #35).

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

import priorAuthRenewalRouter from "./prior-auth-renewal";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
// rt (clinician bucket) lacks patients.update → 403.
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
const PA_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(priorAuthRenewalRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("POST /admin/prior-authorizations/:id/draft-renewal", () => {
  it("401s without admin", async () => {
    expect(
      (
        await request(makeApp()).post(
          `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
        )
      ).status,
    ).toBe(401);
  });

  it("403s for a role without patients.update (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp()).post(
      `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
    );
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("prior_authorizations", "insert")).toBe(0);
  });

  it("400s on a non-uuid id", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(
      "/admin/prior-authorizations/not-a-uuid/draft-renewal",
    );
    expect(res.status).toBe(400);
  });

  it("404s when the source PA doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prior_authorizations", "select", { data: null });
    const res = await request(makeApp()).post(
      `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
    );
    expect(res.status).toBe(404);
  });

  it("409s when the source PA is still a draft (not renewable)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prior_authorizations", "select", {
      data: {
        id: PA_ID,
        patient_id: "p1",
        hcpcs_code: "E0601",
        status: "draft",
      },
    });
    const res = await request(makeApp()).post(
      `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_renewable");
    expect(getSupabaseCallCount("prior_authorizations", "insert")).toBe(0);
  });

  it("409s when an open renewal already exists", async () => {
    mockAdmin.current = ADMIN;
    // 1st select: the source PA (approved → renewable).
    stageSupabaseResponse("prior_authorizations", "select", {
      data: {
        id: PA_ID,
        patient_id: "p1",
        insurance_coverage_id: "cov1",
        hcpcs_code: "E0601",
        payer_name: "Aetna",
        status: "approved",
        approved_through: "2026-06-01",
      },
    });
    // 2nd select: the dedupe lookup finds an existing open draft.
    stageSupabaseResponse("prior_authorizations", "select", {
      data: [{ id: "existing-draft", status: "draft" }],
    });
    const res = await request(makeApp()).post(
      `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("open_renewal_exists");
    expect(res.body.existingId).toBe("existing-draft");
    expect(getSupabaseCallCount("prior_authorizations", "insert")).toBe(0);
  });

  it("clones an expired PA into a fresh draft + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prior_authorizations", "select", {
      data: {
        id: PA_ID,
        patient_id: "p1",
        insurance_coverage_id: "cov1",
        hcpcs_code: "E0601",
        payer_name: "Aetna",
        status: "expired",
        approved_through: "2026-05-01",
      },
    });
    stageSupabaseResponse("prior_authorizations", "select", { data: [] }); // no dup
    stageSupabaseResponse("prior_authorizations", "insert", {
      data: { id: "new-draft-id" },
    });

    const res = await request(makeApp()).post(
      `/admin/prior-authorizations/${PA_ID}/draft-renewal`,
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "new-draft-id",
      sourcePriorAuthId: PA_ID,
    });

    const payload = getSupabaseWritePayloads(
      "prior_authorizations",
      "insert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      patient_id: "p1",
      insurance_coverage_id: "cov1",
      hcpcs_code: "E0601",
      payer_name: "Aetna",
      status: "draft",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("prior_authorization.renewal_drafted");
    expect(audit.metadata).toMatchObject({
      source_prior_auth_id: PA_ID,
      hcpcs_code: "E0601",
    });
  });
});
