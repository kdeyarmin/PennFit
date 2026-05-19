// Route tests for /admin/patient-documents/retention/*.

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

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import retentionRouter from "./patient-documents-retention";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const SUPERVISOR: MockAdminCtx = {
  userId: "u_super",
  email: "sup@penn.example.com",
  role: "agent",
  granularRole: "supervisor",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

const DOC_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(retentionRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/patient-documents/retention", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get(
      "/admin/patient-documents/retention",
    );
    expect(res.status).toBe(401);
  });

  it("403s for CSR (lacks audit.export)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).get(
      "/admin/patient-documents/retention",
    );
    expect(res.status).toBe(403);
  });

  it("filters the actionable queue to due_now / due_soon only", async () => {
    mockAdmin.current = SUPERVISOR;
    // Mixed bag: one already-active row should be filtered OUT of
    // the default actionable surface.
    stageSupabaseResponse("patient_documents", "select", {
      data: [
        {
          id: "d_active",
          patient_id: "p_1",
          document_type: "insurance_card",
          filename: "card.pdf",
          content_type: "application/pdf",
          size_bytes: 1024,
          retention_until_at: "2099-01-01T00:00:00Z",
          legal_hold: false,
          retention_marked_at: null,
          destroyed_at: null,
          destroyed_by_admin_id: null,
          created_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "d_due_now",
          patient_id: "p_2",
          document_type: "insurance_card",
          filename: "old.pdf",
          content_type: "application/pdf",
          size_bytes: 1024,
          retention_until_at: "2020-01-01T00:00:00Z",
          legal_hold: false,
          retention_marked_at: null,
          destroyed_at: null,
          destroyed_by_admin_id: null,
          created_at: "2018-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(makeApp()).get(
      "/admin/patient-documents/retention",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.documents[0].id).toBe("d_due_now");
    expect(res.body.documents[0].bucket).toBe("due_now");
  });
});

describe("POST /admin/patient-documents/:id/legal-hold", () => {
  it("400s without a reason", async () => {
    mockAdmin.current = SUPERVISOR;
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/legal-hold`)
      .send({ hold: true });
    expect(res.status).toBe(400);
  });

  it("409s when the row is already destroyed", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("patient_documents", "select", {
      data: {
        id: DOC_ID,
        legal_hold: false,
        destroyed_at: "2025-01-01T00:00:00Z",
        patient_id: "p_1",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/legal-hold`)
      .send({ hold: true, reason: "audit lookback" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("destroyed");
  });

  it("applies the hold + audits with reason metadata", async () => {
    mockAdmin.current = SUPERVISOR;
    stageSupabaseResponse("patient_documents", "select", {
      data: {
        id: DOC_ID,
        legal_hold: false,
        destroyed_at: null,
        patient_id: "p_1",
      },
    });
    stageSupabaseResponse("patient_documents", "update", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/legal-hold`)
      .send({ hold: true, reason: "Aetna audit Q3" });
    expect(res.status).toBe(200);
    expect(res.body.legalHold).toBe(true);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: { reason: string };
    };
    expect(audit.action).toBe("patient_documents.legal_hold.applied");
    expect(audit.metadata.reason).toBe("Aetna audit Q3");
  });
});

describe("POST /admin/patient-documents/:id/destroy", () => {
  it("403s for supervisor (admin-only)", async () => {
    mockAdmin.current = SUPERVISOR;
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(403);
  });

  it("400s when confirmation phrase is missing", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "yes" });
    expect(res.status).toBe(400);
  });

  it("409s when retention sweep hasn't flagged the row yet", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_documents", "select", {
      data: {
        id: DOC_ID,
        patient_id: "p_1",
        document_type: "insurance_card",
        legal_hold: false,
        destroyed_at: null,
        object_key: "/uploads/x",
        retention_marked_at: null,
        retention_until_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_marked");
  });

  it("409s when legal hold is on", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_documents", "select", {
      data: {
        id: DOC_ID,
        patient_id: "p_1",
        document_type: "insurance_card",
        legal_hold: true,
        destroyed_at: null,
        object_key: "/uploads/x",
        retention_marked_at: "2026-01-01T00:00:00Z",
        retention_until_at: "2025-01-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("legal_hold");
  });

  it("succeeds + audits when properly flagged + no hold", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_documents", "select", {
      data: {
        id: DOC_ID,
        patient_id: "p_1",
        document_type: "prescription",
        legal_hold: false,
        destroyed_at: null,
        object_key: "/uploads/x",
        retention_marked_at: "2026-01-01T00:00:00Z",
        retention_until_at: "2025-01-01T00:00:00Z",
      },
    });
    stageSupabaseResponse("patient_documents", "update", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patient-documents/${DOC_ID}/destroy`)
      .send({ confirm: "DESTROY" });
    expect(res.status).toBe(200);
    expect(res.body.destroyedAt).toBeDefined();
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: { document_type: string };
    };
    expect(audit.action).toBe("patient_documents.destroyed");
    expect(audit.metadata.document_type).toBe("prescription");
  });
});
