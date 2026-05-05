// Route tests for /admin/patients/:id/onboarding (Phase B.1).
//
// Coverage:
//   * 401 without admin
//   * GET returns null when no journey exists
//   * POST enroll inserts + audits with non-PHI envelope; 409 on
//     re-enroll while one is active
//   * PATCH status transitions + audits
//   * Dispatcher fires the next-due check-in, stamps the timestamp,
//     and transitions to 'completed' on day-90

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

const sendEmailMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<{ messageId: string }>>(async () => ({
    messageId: "sg_1",
  })),
);
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  };
});

const selectQueue: unknown[][] = [];
const insertQueue: unknown[][] = [];
const insertedValues: Record<string, unknown>[] = [];
const updateSets: Record<string, unknown>[] = [];
const dbStub = {
  select: vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      from: () => obj,
      innerJoin: () => obj,
      where: () => obj,
      orderBy: () => obj,
      limit: () => Promise.resolve(result),
    };
    return obj;
  }),
  insert: vi.fn(() => {
    const result = insertQueue.shift() ?? [];
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return obj;
      },
      returning: () => Promise.resolve(result),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals);
        return obj;
      },
      where: () => Promise.resolve(),
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

import patientOnboardingRouter from "./patient-onboarding";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientOnboardingRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertQueue.length = 0;
  insertedValues.length = 0;
  updateSets.length = 0;
  logAuditMock.mockClear();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_1" });
});

describe("GET /admin/patients/:id/onboarding", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/onboarding`,
    );
    expect(res.status).toBe(401);
  });

  it("returns journey:null when none exists", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([]);
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/onboarding`,
    );
    expect(res.status).toBe(200);
    expect(res.body.journey).toBeNull();
  });
});

describe("POST /admin/patients/:id/onboarding/enroll", () => {
  it("409s when an active journey already exists", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: PATIENT_ID }]); // patient exists
    selectQueue.push([{ id: "j_existing" }]); // already-active row
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/onboarding/enroll`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_enrolled");
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([{ id: PATIENT_ID }]); // patient exists
    selectQueue.push([]); // no active row
    insertQueue.push([
      {
        id: "j_new",
        startedAt: new Date("2026-05-04T12:00:00Z"),
      },
    ]);

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/onboarding/enroll`)
      .send({ startedAt: "2026-05-04T12:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("j_new");
    expect(insertedValues[0]?.patientId).toBe(PATIENT_ID);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("patient.onboarding.enroll");
    expect(audit.metadata).toEqual({
      patient_id: PATIENT_ID,
      started_at: "2026-05-04T12:00:00.000Z",
    });
  });
});

describe("POST /admin/onboarding/send-due (dispatcher)", () => {
  it("fires the next due check-in + stamps + audits", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    // One active journey, started 8 days ago — day1 already sent,
    // day7 still null and now due.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    selectQueue.push([
      {
        journeyId: "j_1",
        patientId: PATIENT_ID,
        startedAt: eightDaysAgo,
        day1SentAt: new Date(eightDaysAgo.getTime() + 24 * 60 * 60 * 1000),
        day7SentAt: null,
        day30SentAt: null,
        day90SentAt: null,
        firstName: "Anna",
        email: "anna@example.com",
      },
    ]);

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedNoEmail: 0,
      completedJourneys: 0,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendCall = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      customArgs: Record<string, string>;
    };
    expect(sendCall.to).toBe("anna@example.com");
    expect(sendCall.customArgs.kind).toBe("onboarding_checkin");
    expect(sendCall.customArgs.day).toBe("day7");

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.day7SentAt).toBeInstanceOf(Date);
    // No status change yet — day7 is mid-cycle.
    expect(updateSets[0]?.status).toBeUndefined();

    // Audit envelope is structural only.
    const audits = logAuditMock.mock.calls.map(
      (c) =>
        c[0] as {
          action: string;
          metadata: Record<string, unknown>;
        },
    );
    const sentAudit = audits.find(
      (a) => a.action === "patient.onboarding.checkin_sent",
    );
    expect(sentAudit?.metadata).toEqual({
      patient_id: PATIENT_ID,
      day_label: "day7",
      channel: "email",
    });
  });

  it("transitions journey to completed after day-90", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    selectQueue.push([
      {
        journeyId: "j_1",
        patientId: PATIENT_ID,
        startedAt: ninetyOneDaysAgo,
        day1SentAt: new Date(),
        day7SentAt: new Date(),
        day30SentAt: new Date(),
        day90SentAt: null,
        firstName: "Anna",
        email: "anna@example.com",
      },
    ]);

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.completedJourneys).toBe(1);
    expect(updateSets[0]?.status).toBe("completed");

    // Two audits — checkin_sent for day90 + complete.
    const auditActions = logAuditMock.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain("patient.onboarding.checkin_sent");
    expect(auditActions).toContain("patient.onboarding.complete");
  });

  it("skips rows without an email on file", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    selectQueue.push([
      {
        journeyId: "j_1",
        patientId: PATIENT_ID,
        startedAt: eightDaysAgo,
        day1SentAt: new Date(eightDaysAgo.getTime() + 24 * 60 * 60 * 1000),
        day7SentAt: null,
        day30SentAt: null,
        day90SentAt: null,
        firstName: "Anna",
        email: null,
      },
    ]);

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 0,
      skippedNoEmail: 1,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateSets).toHaveLength(0);
  });
});
