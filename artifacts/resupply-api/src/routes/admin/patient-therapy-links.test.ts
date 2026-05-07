// Route tests for /admin/patients/:id/therapy-links (Phase E.1
// linkage CRUD). Mirrors patient-therapy-sync.test.ts:
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

interface InsertResult {
  rows?: unknown[];
  err?: { code?: string; constraint?: string; message?: string };
}
interface UpdateResult {
  rows?: unknown[];
  err?: { code?: string; constraint?: string; message?: string };
}

const dbState = vi.hoisted(
  (): {
    selectQueue: unknown[][];
    insertResult: InsertResult;
    insertedValues: Record<string, unknown>[];
    updateResult: UpdateResult;
    updatePatches: Record<string, unknown>[];
  } => ({
    selectQueue: [],
    insertResult: { rows: [] },
    insertedValues: [],
    updateResult: { rows: [] },
    updatePatches: [],
  }),
);

const dbStub = {
  select: vi.fn(() => {
    const result = dbState.selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => Promise.resolve(result),
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        dbState.insertedValues.push(vals);
        return obj;
      },
      returning: () => {
        if (dbState.insertResult.err) {
          return Promise.reject(dbState.insertResult.err);
        }
        return Promise.resolve(dbState.insertResult.rows ?? []);
      },
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (patch: Record<string, unknown>) => {
        dbState.updatePatches.push(patch);
        return obj;
      },
      where: () => obj,
      returning: () => {
        if (dbState.updateResult.err) {
          return Promise.reject(dbState.updateResult.err);
        }
        return Promise.resolve(dbState.updateResult.rows ?? []);
      },
    };
    return obj;
  }),
};
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: () => dbStub,
}));

vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/resupply-db")>(
    "@workspace/resupply-db",
  );
  return { ...actual, getDbPool: () => ({}) as never };
});

import patientTherapyLinksRouter from "./patient-therapy-links";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const LINK_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientTherapyLinksRouter);
  return app;
}

function admin() {
  mockAdmin.current = {
    userId: "u_admin",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-07T12:00:00Z");
  return {
    id: LINK_ID,
    patientId: PATIENT_ID,
    source: "resmed_airview",
    partnerPatientId: "rm_999",
    deviceSerial: null,
    status: "active",
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  dbState.selectQueue = [];
  dbState.insertResult = { rows: [] };
  dbState.insertedValues = [];
  dbState.updateResult = { rows: [] };
  dbState.updatePatches = [];
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
    dbState.selectQueue.push([makeRow()]);
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
    dbState.selectQueue.push([]); // patients lookup empty
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(404);
  });

  it("happy path: 201 + PHI-clean audit envelope", async () => {
    admin();
    dbState.selectQueue.push([{ id: PATIENT_ID }]);
    dbState.insertResult = { rows: [makeRow({ partnerPatientId: "rm_42" })] };

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({
        source: "resmed_airview",
        partnerPatientId: "rm_42",
        deviceSerial: "SN-ABC-1",
      });

    expect(res.status).toBe(201);
    expect(res.body.link.id).toBe(LINK_ID);

    expect(dbState.insertedValues).toHaveLength(1);
    expect(dbState.insertedValues[0]).toMatchObject({
      patientId: PATIENT_ID,
      source: "resmed_airview",
      partnerPatientId: "rm_42",
      deviceSerial: "SN-ABC-1",
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
    dbState.selectQueue.push([{ id: PATIENT_ID }]);
    dbState.insertResult = {
      err: {
        code: "23505",
        constraint: "patient_therapy_links_active_unique",
        message: "duplicate key",
      },
    };
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/therapy-links`)
      .send({ source: "resmed_airview", partnerPatientId: "rm_1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("active_link_exists");
  });

  it("409 partner_id_in_use on global-unique violation", async () => {
    admin();
    dbState.selectQueue.push([{ id: PATIENT_ID }]);
    dbState.insertResult = {
      err: {
        code: "23505",
        constraint: "patient_therapy_links_partner_unique",
        message: "duplicate key",
      },
    };
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
    dbState.updateResult = { rows: [] };
    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "paused" });
    expect(res.status).toBe(404);
  });

  it("happy path: returns updated row + audit changed_fields", async () => {
    admin();
    dbState.updateResult = { rows: [makeRow({ status: "paused" })] };

    const res = await request(makeApp())
      .patch(`/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("paused");
    expect(dbState.updatePatches[0]).toEqual({ status: "paused" });

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.therapy_link.updated");
    expect(audit.metadata.changed_fields).toEqual(["status"]);
  });
});

describe("DELETE /admin/patients/:id/therapy-links/:linkId", () => {
  it("soft-revokes (status='revoked') + audits", async () => {
    admin();
    dbState.updateResult = { rows: [makeRow({ status: "revoked" })] };

    const res = await request(makeApp()).delete(
      `/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("revoked");
    expect(dbState.updatePatches[0]).toEqual({ status: "revoked" });

    const audit = logAuditMock.mock.calls[0]?.[0] as { action: string };
    expect(audit.action).toBe("patient.therapy_link.revoked");
  });

  it("404s when the link doesn't exist", async () => {
    admin();
    dbState.updateResult = { rows: [] };
    const res = await request(makeApp()).delete(
      `/admin/patients/${PATIENT_ID}/therapy-links/${LINK_ID}`,
    );
    expect(res.status).toBe(404);
  });
});
