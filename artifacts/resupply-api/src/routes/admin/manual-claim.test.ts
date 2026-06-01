// Tests for /admin/patients/:id/manual-claims (Biller #32) — the pure
// adjustment validator + the HTTP route.

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

import manualClaimRouter, { validateManualClaim } from "./manual-claim";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const RT: MockAdminCtx = {
  userId: "u_rt",
  email: "rt@penn.example.com",
  role: "agent",
  granularRole: "rt",
};
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(manualClaimRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("validateManualClaim (pure)", () => {
  it("requires originalClaimNumber for a replacement (7) or void (8)", () => {
    expect(validateManualClaim({ claimFrequencyCode: "7" }).ok).toBe(false);
    expect(
      validateManualClaim({ claimFrequencyCode: "8", originalClaimNumber: "" })
        .ok,
    ).toBe(false);
    const ok = validateManualClaim({
      claimFrequencyCode: "7",
      originalClaimNumber: "ICN123",
    });
    expect(ok.ok).toBe(true);
    expect(ok.entrySource).toBe("adjustment");
  });

  it("rejects an originalClaimNumber on an original (1) and maps source", () => {
    expect(
      validateManualClaim({
        claimFrequencyCode: "1",
        originalClaimNumber: "ICN123",
      }).ok,
    ).toBe(false);
    const ok = validateManualClaim({ claimFrequencyCode: "1" });
    expect(ok.ok).toBe(true);
    expect(ok.entrySource).toBe("manual");
  });
});

describe("POST /admin/patients/:id/manual-claims", () => {
  it("401s without admin", async () => {
    expect(
      (
        await request(makeApp()).post(
          `/admin/patients/${PATIENT_ID}/manual-claims`,
        )
      ).status,
    ).toBe(401);
  });

  it("403s for a role without patients.update (rt)", async () => {
    mockAdmin.current = RT;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-05-01" });
    expect(res.status).toBe(403);
    expect(getSupabaseCallCount("insurance_claims", "insert")).toBe(0);
  });

  it("400s when a replacement omits the original claim number", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({
        payerName: "Aetna",
        dateOfService: "2026-05-01",
        claimFrequencyCode: "7",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_adjustment");
    expect(getSupabaseCallCount("insurance_claims", "insert")).toBe(0);
  });

  it("404s when the patient doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-05-01" });
    expect(res.status).toBe(404);
  });

  it("creates a void/replacement draft + stamps the adjustment fields + audits", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "new-claim-id" },
    });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({
        payerName: "UHC",
        dateOfService: "2026-04-15",
        claimFrequencyCode: "7",
        originalClaimNumber: "ICN-99887766",
      });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "new-claim-id",
      entrySource: "adjustment",
      claimFrequencyCode: "7",
    });

    const payload = getSupabaseWritePayloads(
      "insurance_claims",
      "insert",
    )[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      patient_id: PATIENT_ID,
      payer_name: "UHC",
      status: "draft",
      claim_frequency_code: "7",
      original_claim_number: "ICN-99887766",
      entry_source: "adjustment",
      fulfillment_id: null,
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect((logAuditMock.mock.calls[0]?.[0] as { action: string }).action).toBe(
      "insurance_claim.manual_create",
    );
  });
});
