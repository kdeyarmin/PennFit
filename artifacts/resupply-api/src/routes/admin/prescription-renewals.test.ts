// Route tests for /admin/prescriptions/send-renewal-due (Phase B.2).
//
// Coverage:
//   * 401 without admin
//   * 503 when SendGrid is not configured
//   * Sends + stamps + audits with non-PHI envelope
//   * Skips rows with no email; counts increment correctly
//   * SendGrid throw → counted as failed; row remains eligible

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
const sendgridConfigured = vi.hoisted(() => ({ current: true }));
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => {
      if (!sendgridConfigured.current) {
        throw new actual.EmailConfigError("not configured");
      }
      return { sendEmail: sendEmailMock };
    },
  };
});

const selectQueue: unknown[][] = [];
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

import prescriptionRenewalsRouter from "./prescription-renewals";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(prescriptionRenewalsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  selectQueue.length = 0;
  updateSets.length = 0;
  logAuditMock.mockClear();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_1" });
  sendgridConfigured.current = true;
});

describe("POST /admin/prescriptions/send-renewal-due", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );
    expect(res.status).toBe(401);
  });

  it("503s when SendGrid is not configured", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    sendgridConfigured.current = false;
    selectQueue.push([]);
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_not_configured");
  });

  it("sends + stamps + audits with non-PHI envelope", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    const inFiveDays = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    selectQueue.push([
      {
        prescriptionId: "rx_1",
        patientId: "p_1",
        validUntil: inFiveDays,
        firstName: "Anna",
        email: "anna@example.com",
      },
    ]);

    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedNoEmail: 0,
      windowDays: 30,
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const sendCall = sendEmailMock.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      customArgs: Record<string, string>;
    };
    expect(sendCall.to).toBe("anna@example.com");
    expect(sendCall.customArgs).toMatchObject({
      kind: "prescription_renewal_request",
      prescription_id: "rx_1",
    });

    expect(updateSets).toHaveLength(1);
    expect(updateSets[0]?.renewalRequestedAt).toBeInstanceOf(Date);

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("prescription.renewal_requested");
    expect(audit.metadata.patient_id).toBe("p_1");
    expect(audit.metadata.channel).toBe("email");
    // Days-until-expiry is structural; clamped to >=0.
    expect(typeof audit.metadata.days_until_expiry).toBe("number");
    expect(audit.metadata.days_until_expiry).toBeGreaterThanOrEqual(4);
    expect(audit.metadata.days_until_expiry).toBeLessThanOrEqual(5);
  });

  it("skips rows without an email + does not stamp", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        prescriptionId: "rx_1",
        patientId: "p_1",
        validUntil: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        firstName: "Anna",
        email: null,
      },
    ]);
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 0,
      skippedNoEmail: 1,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });

  it("counts SendGrid throws as failed without stamping", async () => {
    mockAdmin.current = {
      userId: "u_admin",
      email: "ops@penn.example.com",
      role: "admin",
    };
    selectQueue.push([
      {
        prescriptionId: "rx_1",
        patientId: "p_1",
        validUntil: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        firstName: "Anna",
        email: "anna@example.com",
      },
    ]);
    sendEmailMock.mockRejectedValueOnce(new Error("sendgrid down"));

    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 0,
      failed: 1,
    });
    // Row stays eligible — no UPDATE on failure.
    expect(updateSets).toEqual([]);
    // Audit only logs successful sends.
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
