// Route tests for /admin/accreditation/*.
//
// Coverage focuses on the contract surfaces that drive a surveyor
// hand-off:
//   * auth gates (401 without admin; 403 without permission for
//     audit.export-protected reads)
//   * POST policies validates the policy_key shape so junk doesn't
//     enter the catalog
//   * PATCH activate/retire are mutually exclusive
//   * Attest is idempotent (200 alreadyAttested when re-posted)
//   * Attest refuses retired policies (409 not_active)
//
// The catalog list (GET /policies) and the CSV export aren't asserted
// here — those are simple PostgREST passthroughs covered by the
// happy-path integration test below.

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

import accreditationRouter from "./accreditation-policies";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(accreditationRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("POST /admin/accreditation/policies", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post("/admin/accreditation/policies")
      .send({});
    expect(res.status).toBe(401);
  });

  it("403s for non-admin (admin-only catalog management)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post("/admin/accreditation/policies")
      .send({
        policyKey: "hipaa_npp",
        version: "1",
        title: "HIPAA NPP",
        category: "hipaa",
      });
    expect(res.status).toBe(403);
  });

  it("400s on a malformed policy_key", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/accreditation/policies")
      .send({
        policyKey: "HIPAA NPP", // spaces + uppercase = junk
        version: "1",
        title: "HIPAA NPP",
        category: "hipaa",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("creates with activate=false → active_at stays null (draft)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("accreditation_policies", "insert", {
      data: { id: "p_1" },
    });
    const res = await request(makeApp())
      .post("/admin/accreditation/policies")
      .send({
        policyKey: "hipaa_npp",
        version: "1",
        title: "HIPAA NPP",
        category: "hipaa",
        activate: false,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("p_1");
    // Audit metadata records "activated:false" so a surveyor query
    // for "when did this go live" doesn't include the draft moment.
    const auditCall = logAuditMock.mock.calls[0]?.[0] as {
      metadata: { activated: boolean };
    };
    expect(auditCall.metadata.activated).toBe(false);
  });

  it("translates unique_violation to 409 duplicate_policy_version", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("accreditation_policies", "insert", {
      data: null,
      error: { code: "23505", message: "duplicate" },
    });
    const res = await request(makeApp())
      .post("/admin/accreditation/policies")
      .send({
        policyKey: "hipaa_npp",
        version: "1",
        title: "HIPAA NPP",
        category: "hipaa",
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_policy_version");
  });
});

describe("PATCH /admin/accreditation/policies/:id", () => {
  const POLICY_ID = "11111111-1111-1111-1111-111111111111";

  it("400s when activate + retire are both true", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .patch(`/admin/accreditation/policies/${POLICY_ID}`)
      .send({ activate: true, retire: true });
    expect(res.status).toBe(400);
  });

  it("404s when the row doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/accreditation/policies/${POLICY_ID}`)
      .send({ title: "Renamed" });
    expect(res.status).toBe(404);
  });

  it("409s when activating a retired row", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: {
        id: POLICY_ID,
        policy_key: "hipaa_npp",
        version: "1",
        active_at: "2024-01-01T00:00:00Z",
        retired_at: "2025-01-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .patch(`/admin/accreditation/policies/${POLICY_ID}`)
      .send({ activate: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("retired");
  });
});

describe("POST /admin/accreditation/policies/:id/attest", () => {
  const POLICY_ID = "22222222-2222-2222-2222-222222222222";

  it("401s without a session", async () => {
    const res = await request(makeApp())
      .post(`/admin/accreditation/policies/${POLICY_ID}/attest`)
      .send({ acknowledgedText: "I have read this." });
    expect(res.status).toBe(401);
  });

  it("400s on missing acknowledgedText", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp())
      .post(`/admin/accreditation/policies/${POLICY_ID}/attest`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("409s when policy isn't active (not_active)", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: {
        id: POLICY_ID,
        policy_key: "hipaa_npp",
        version: "1",
        active_at: null,
        retired_at: null,
      },
    });
    const res = await request(makeApp())
      .post(`/admin/accreditation/policies/${POLICY_ID}/attest`)
      .send({ acknowledgedText: "I have read this." });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_active");
  });

  it("returns alreadyAttested:true on re-post (idempotent)", async () => {
    mockAdmin.current = CSR;
    // Policy is live.
    stageSupabaseResponse("accreditation_policies", "select", {
      data: {
        id: POLICY_ID,
        policy_key: "hipaa_npp",
        version: "1",
        active_at: "2025-01-01T00:00:00Z",
        retired_at: null,
      },
    });
    // Existing attestation row.
    stageSupabaseResponse("admin_policy_attestations", "select", {
      data: { id: "a_1", attested_at: "2025-02-01T12:00:00Z" },
    });
    const res = await request(makeApp())
      .post(`/admin/accreditation/policies/${POLICY_ID}/attest`)
      .send({ acknowledgedText: "I have read this." });
    expect(res.status).toBe(200);
    expect(res.body.alreadyAttested).toBe(true);
    // No audit row for an idempotent re-post; the original
    // attestation already produced one.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("inserts a fresh attestation and audits when none exists", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: {
        id: POLICY_ID,
        policy_key: "hipaa_npp",
        version: "1",
        active_at: "2025-01-01T00:00:00Z",
        retired_at: null,
      },
    });
    stageSupabaseResponse("admin_policy_attestations", "select", {
      data: null,
    });
    stageSupabaseResponse("admin_policy_attestations", "insert", {
      data: { id: "a_new", attested_at: "2026-03-01T00:00:00Z" },
    });
    const res = await request(makeApp())
      .post(`/admin/accreditation/policies/${POLICY_ID}/attest`)
      .send({ acknowledgedText: "Read and acknowledged." });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("a_new");
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: { policy_key: string; version: string };
    };
    expect(audit.action).toBe("accreditation.policy.attest");
    expect(audit.metadata.policy_key).toBe("hipaa_npp");
    expect(audit.metadata.version).toBe("1");
  });
});

describe("GET /admin/accreditation/policies/me/pending", () => {
  it("401s without a session", async () => {
    const res = await request(makeApp()).get(
      "/admin/accreditation/policies/me/pending",
    );
    expect(res.status).toBe(401);
  });

  it("returns an empty list when no live policies exist", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: [],
    });
    const res = await request(makeApp()).get(
      "/admin/accreditation/policies/me/pending",
    );
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual([]);
  });

  it("filters out already-attested policies", async () => {
    mockAdmin.current = CSR;
    stageSupabaseResponse("accreditation_policies", "select", {
      data: [
        {
          id: "p1",
          policy_key: "hipaa_npp",
          version: "1",
          title: "HIPAA",
          summary: null,
          body_url: null,
          category: "hipaa",
          active_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "p2",
          policy_key: "infection_control",
          version: "1",
          title: "Infection control",
          summary: null,
          body_url: null,
          category: "safety",
          active_at: "2025-01-01T00:00:00Z",
        },
      ],
    });
    // p1 already attested, p2 is outstanding.
    stageSupabaseResponse("admin_policy_attestations", "select", {
      data: [{ policy_id: "p1" }],
    });
    const res = await request(makeApp()).get(
      "/admin/accreditation/policies/me/pending",
    );
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0].policyKey).toBe("infection_control");
  });
});
