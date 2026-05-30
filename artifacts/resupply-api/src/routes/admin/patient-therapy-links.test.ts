// Route tests for /admin/patients/:id/therapy-links (Phase E.1
// linkage CRUD).
//   * 401 without admin
//   * GET returns rows; PHI-adjacent fields are surfaced (admin-gated)
//   * POST happy path: 201, audit envelope is PHI-clean
//   * POST 23505 on active partial unique → 409 active_link_exists
//   * POST 23505 on global partner unique → 409 partner_id_in_use
//   * PATCH happy path returns updated row + audit
//   * DELETE soft-revokes (status='revoked'), audit fires

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
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import patientTherapyLinksRouter from "./patient-therapy-links";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const LINK_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientTherapyLinksRouter);
  return app;
}

function admin() {
  mockAdmin.current = ADMIN;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  // PostgREST returns snake_case columns. The route's `toResponse`
  // helper maps those to camelCase for the JSON body.
  const now = new Date("2026-05-07T12:00:00Z").toISOString();
  return {
    id: LINK_ID,
    patient_id: PATIENT_ID,
    source: "resmed_airview",
    partner_patient_id: "rm_999",
    device_serial: null,
    status: "active",
    last_synced_at: null,
    last_sync_status: null,
    last_sync_error: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/patients/:id/therapy-links", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-links`,
    );
    expect(res.status).toBe(401);
  });

  it("returns the patient's links", async () => {
    admin();
    stageSupabaseResponse("patient_therapy_links", "select", {
      data: [makeRow()],
    });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/therapy-links`,
    );
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(1);
    expect(res.body.links[0]).toMatchObject({
      id: LINK_ID,
      patientId: PATIENT_ID,
      source: "resmed_airview",
      partnerPatientId: "rm_999",
      status: "active",
    });
    // Timestamps come back as ISO strings, not Date objects.
    expect(typeof res.body.links[0].createdAt).toBe("string");
    expect(res.body.links[0].lastSyncedAt).toBeNull();
  });
});

describe("POST /admin/patients/:id/therapy-links", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(401);
  });

  it("400s on bad body", async () => {
    admin();
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "bogus", partnerPatientId: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("404s when the patient doesn't exist", async () => {
    admin();
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(404);
  });

  it("happy path: 201 + PHI-clean audit envelope", async () => {
    admin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_therapy_links", "insert", {
      data: makeRow({ partner_patient_id: "rm_42" }),
    });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({
        source: "resmed_airview",
        partnerPatientId: "rm_42",
        deviceSerial: "SN-ABC-1",
      });

    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(LINK_ID);

    const inserts = getSupabaseWritePayloads("patient_therapy_links", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      patient_id: PATIENT_ID,
      source: "resmed_airview",
      partner_patient_id: "rm_42",
      device_serial: "SN-ABC-1",
      status: "active",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.therapy_link.created");
    // Envelope has ids only — partner id and device serial are
    // PHI-adjacent and must NOT appear here.
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      link_id: LINK_ID,
      source: "resmed_airview",
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("rm_42");
    expect(JSON.stringify(audit.metadata)).not.toContain("SN-ABC-1");
  });

  it("409 active_link_exists on partial-unique violation", async () => {
    admin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_therapy_links", "insert", {
      error: {
        code: "23505",
        constraint: "patient_therapy_links_active_unique",
        message: "duplicate key",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("active_link_exists");
  });

  it("409 partner_id_in_use on global-unique violation", async () => {
    admin();
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_therapy_links", "insert", {
      error: {
        code: "23505",
        constraint: "patient_therapy_links_partner_unique",
        message: "duplicate key",
      },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("partner_id_in_use");
  });
});

describe("PATCH /admin/patients/:id/therapy-links/:linkId", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(401);
  });

  it("400s on empty body", async () => {
    admin();
    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s when the link doesn't exist", async () => {
    admin();
    // UPDATE … RETURNING with .maybeSingle() returns null when no row
    // matched the (patient_id, link_id) filter pair.
    stageSupabaseResponse("patient_therapy_links", "update", { data: null });
    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(404);
  });

  it("happy path: returns updated row + audit changed_fields", async () => {
    admin();
    stageSupabaseResponse("patient_therapy_links", "update", {
      data: makeRow({ status: "paused" }),
    });

    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("paused");
    const updates = getSupabaseWritePayloads("patient_therapy_links", "update");
    expect(updates[0]).toEqual({ status: "paused" });

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.therapy_link.updated");
    expect(audit.metadata.changed_fields).toEqual(["status"]);
  });

  it("409 active_link_exists when setting status=active violates partial unique", async () => {
    admin();
    stageSupabaseResponse("patient_therapy_links", "update", {
      error: {
        code: "23505",
        constraint: "patient_therapy_links_active_unique",
        message: "duplicate key",
      },
    });
    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "active" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("active_link_exists");
  });
});

describe("DELETE /admin/patients/:id/therapy-links/:linkId", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).delete(
      `/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("soft-revokes (status='revoked') + audits", async () => {
    admin();
    stageSupabaseResponse("patient_therapy_links", "update", {
      data: makeRow({ status: "revoked" }),
    });

    const res = await request(makeApp()).delete(
      `/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("revoked");
    const updates = getSupabaseWritePayloads("patient_therapy_links", "update");
    expect(updates[0]).toEqual({ status: "revoked" });

    const audit = logAuditMock.mock.calls[0]?.[0] as { action: string };
    expect(audit.action).toBe("patient.therapy_link.revoked");
  });

  it("404s when the link doesn't exist", async () => {
    admin();
    stageSupabaseResponse("patient_therapy_links", "update", { data: null });
    const res = await request(makeApp()).delete(
      `/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`,
    );
    expect(res.status).toBe(404);
  });
});
