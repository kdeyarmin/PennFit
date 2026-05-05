// Route tests for /patients/:id/followups (Phase 19).
// Mirrors customer-followups.test.ts but on the patient surface.

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

const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const updateQueue: unknown[][] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const result = insertQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      values: () => obj,
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const result = updateQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      set: () => obj,
      where: () => obj,
      returning: () => Promise.resolve(result),
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

import followupsRouter from "./followups";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const FOLLOWUP_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(followupsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertQueue.length = 0;
  updateQueue.length = 0;
  logAuditMock.mockClear();
  dbStub.select.mockClear();
  dbStub.insert.mockClear();
  dbStub.update.mockClear();
});

describe("GET /patients/:id/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(401);
  });

  it("404s when the patient doesn't exist", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("returns the open queue", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: PATIENT_ID }]);
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        body: "Follow up on prescription expiry",
        dueAt: new Date("2026-05-12T16:00:00Z"),
        completedAt: null,
        completedByEmail: null,
        createdByEmail: "ops@penn.example.com",
        createdAt: new Date("2026-05-04T12:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).get(
      `/patients/${PATIENT_ID}/followups`,
    );
    expect(res.status).toBe(200);
    expect(res.body.followups).toHaveLength(1);
    expect(res.body.followups[0].body).toBe("Follow up on prescription expiry");
  });
});

describe("POST /patients/:id/followups", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body: "x", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body: "  ", dueAt: "2026-05-10T16:00:00Z" });
    expect(res.status).toBe(400);
    expect(dbStub.insert).not.toHaveBeenCalled();
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: PATIENT_ID }]);
    insertQueue.push([
      {
        id: FOLLOWUP_ID,
        createdAt: new Date("2026-05-04T12:00:00Z"),
        dueAt: new Date("2026-05-10T16:00:00Z"),
      },
    ]);

    const body =
      "Patient said device is leaking — verify replacement mask shipped.";
    const res = await request(makeApp())
      .post(`/patients/${PATIENT_ID}/followups`)
      .send({ body, dueAt: "2026-05-10T16:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(FOLLOWUP_ID);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.followup.create");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      body_length: body.length,
      due_at: "2026-05-10T16:00:00.000Z",
    });
    // No body content in the audit envelope — patient bodies almost
    // certainly carry PHI.
    expect(JSON.stringify(audit.metadata)).not.toContain("leaking");
    expect(JSON.stringify(audit.metadata)).not.toContain("replacement");
  });
});

describe("PATCH /patients/:id/followups/:fid/complete", () => {
  it("404s when the followup belongs to a different patient", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        patientId: "33333333-3333-4333-8333-333333333333",
        completedAt: null,
        body: "x",
      },
    ]);
    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(404);
  });

  it("409s when the followup is already complete", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        patientId: PATIENT_ID,
        completedAt: new Date("2026-05-04T15:00:00Z"),
        body: "x",
      },
    ]);
    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );
    expect(res.status).toBe(409);
  });

  it("marks complete + audits", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        id: FOLLOWUP_ID,
        patientId: PATIENT_ID,
        completedAt: null,
        body: "Confirm replacement",
      },
    ]);
    updateQueue.push([
      {
        id: FOLLOWUP_ID,
        completedAt: new Date("2026-05-05T16:00:00Z"),
      },
    ]);

    const res = await request(makeApp()).patch(
      `/patients/${PATIENT_ID}/followups/${FOLLOWUP_ID}/complete`,
    );

    expect(res.status).toBe(200);
    expect(res.body.completedAt).toBe("2026-05-05T16:00:00.000Z");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.followup.complete");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      body_length: "Confirm replacement".length,
    });
  });
});
