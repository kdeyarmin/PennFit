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
      lineCount: 0,
      totalBilledCents: 0,
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

  it("409s when an active duplicate claim already exists", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    // The duplicate-guard select finds an active claim with the same identity.
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: "existing-claim-id" },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({ payerName: "Aetna", dateOfService: "2026-05-01" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_claim");
    expect(res.body.existingClaimId).toBe("existing-claim-id");
    // No claim was inserted.
    expect(getSupabaseCallCount("insurance_claims", "insert")).toBe(0);
  });

  it("creates a draft WITH line items and computes total_billed_cents", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("insurance_claims", "select", { data: null }); // no dup
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "new-claim-id" },
    });
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
    });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({
        payerName: "Aetna",
        dateOfService: "2026-05-01",
        payerProfileId: "33333333-3333-4333-8333-333333333333",
        lines: [
          { hcpcsCode: "e0601", quantity: 1, billedCents: 120000 },
          {
            hcpcsCode: "A7037",
            quantity: 2,
            billedCents: 5000,
            modifier: "RR,KX",
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.lineCount).toBe(2);
    expect(res.body.totalBilledCents).toBe(125000);
    // Header carries the structured payer + total.
    const header = getSupabaseWritePayloads("insurance_claims", "insert")[0] as
      | Record<string, unknown>
      | undefined;
    expect(header).toMatchObject({
      payer_profile_id: "33333333-3333-4333-8333-333333333333",
      total_billed_cents: 125000,
    });
    // Lines inserted with HCPCS upper-cased.
    const lineRows = getSupabaseWritePayloads(
      "insurance_claim_line_items",
      "insert",
    )[0] as Array<Record<string, unknown>>;
    expect(lineRows).toHaveLength(2);
    expect(lineRows[0]).toMatchObject({
      hcpcs_code: "E0601",
      billed_cents: 120000,
    });
    expect(lineRows[1]).toMatchObject({ modifier: "RR,KX", quantity: 2 });
  });

  it("400s for an invalid HCPCS in a line item", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/manual-claims`)
      .send({
        payerName: "Aetna",
        dateOfService: "2026-05-01",
        lines: [{ hcpcsCode: "!!", quantity: 1, billedCents: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("insurance_claims", "insert")).toBe(0);
  });
});
