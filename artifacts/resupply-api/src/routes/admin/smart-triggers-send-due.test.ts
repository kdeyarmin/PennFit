// Route tests for /admin/smart-triggers/send-due (Phase G.7).
//
// Covers both channels: email (existing path, regression coverage)
// and SMS (new in this phase). The dispatcher iterates rows from
// patient_smart_trigger_events joined to patients; this test stubs
// drizzle so we only need to script the joined-query result.
//
// Audit invariant: metadata.channel reflects the channel actually
// used. Body content (SMS or email) never appears in the audit log.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

const sendSmsMock = vi.hoisted(() =>
  vi.fn<
    (input: { to: string; body: string }) => Promise<{ messageSid: string }>
  >(async () => ({ messageSid: "SM_1" })),
);
const twilioConfigured = vi.hoisted(() => ({ current: true }));
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioSmsClient: () => {
      if (!twilioConfigured.current) {
        throw new actual.TwilioConfigError("not configured");
      }
      return { sendSms: sendSmsMock };
    },
  };
});

const sendPushToCustomerByEmailMock = vi.hoisted(() =>
  vi.fn<
    (
      email: string,
      payload: {
        title: string;
        body: string;
        url?: string;
        tag?: string;
      },
    ) => Promise<{ delivered: number; expired: number; transient: number }>
  >(async () => ({ delivered: 0, expired: 0, transient: 0 })),
);
vi.mock("../../lib/web-push", () => ({
  sendPushToCustomerByEmail: sendPushToCustomerByEmailMock,
  sendPushToCustomer: vi.fn(),
  isPushConfigured: () => false,
}));

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
  insert: vi.fn(() => {
    // The /evaluate endpoint also lives in this router but isn't
    // exercised here — provide a chainable no-op so route mounting
    // doesn't throw at module load.
    const obj: Record<string, unknown> = {
      values: () => obj,
      onConflictDoNothing: () => obj,
      returning: () => Promise.resolve([]),
    };
    return obj;
  }),
  selectDistinct: vi.fn(() => {
    const obj: Record<string, unknown> = {
      from: () => obj,
      where: () => obj,
      limit: () => Promise.resolve([]),
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

import smartTriggersRouter from "./smart-triggers";

const ADMIN_EMAIL = "ops@penn.example.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(smartTriggersRouter);
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
  sendSmsMock.mockClear();
  sendSmsMock.mockResolvedValue({ messageSid: "SM_1" });
  twilioConfigured.current = true;
  sendPushToCustomerByEmailMock.mockClear();
});
afterEach(() => {
  selectQueue.length = 0;
});

describe("POST /admin/smart-triggers/send-due (email — regression)", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post("/admin/smart-triggers/send-due");
    expect(res.status).toBe(401);
  });

  it("503s when SendGrid is not configured", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    sendgridConfigured.current = false;
    selectQueue.push([]);
    const res = await request(makeApp()).post("/admin/smart-triggers/send-due");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_not_configured");
  });

  it("sends + stamps + audits with channel='email'", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        eventId: "evt_1",
        patientId: "p_1",
        kind: "leak_rising",
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-29",
        firstName: "Anna",
        email: "anna@example.com",
        phoneE164: "+12155551212",
      },
    ]);
    const res = await request(makeApp()).post("/admin/smart-triggers/send-due");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedNoEmail: 0,
      channel: "email",
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).not.toHaveBeenCalled();

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.channel).toBe("email");

    // Phase G.8 — push fan-out fires by email lookup. Best-effort:
    // the helper itself returns {0,0,0} when no customer matches,
    // and the route logs and continues either way.
    expect(sendPushToCustomerByEmailMock).toHaveBeenCalledTimes(1);
    const [pushEmail, pushPayload] =
      sendPushToCustomerByEmailMock.mock.calls[0]!;
    expect(pushEmail).toBe("anna@example.com");
    expect(pushPayload.url).toBe("/account/insights");
    expect(pushPayload.tag).toMatch(/^smart_trigger:/);
    expect(pushPayload.title).toBe("Your CPAP mask seal may need attention");
  });
});

describe("POST /admin/smart-triggers/send-due?channel=sms (Phase G.7)", () => {
  it("503s when Twilio is missing", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    twilioConfigured.current = false;
    selectQueue.push([]);
    const res = await request(makeApp()).post(
      "/admin/smart-triggers/send-due?channel=sms",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sms_not_configured");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("400s on invalid channel value", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    const res = await request(makeApp()).post(
      "/admin/smart-triggers/send-due?channel=carrier-pigeon",
    );
    expect(res.status).toBe(400);
  });

  it("sends SMS + stamps + audits with channel='sms'; never logs body", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        eventId: "evt_1",
        patientId: "p_1",
        kind: "cushion_wear",
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-29",
        firstName: "Anna",
        email: null,
        phoneE164: "+12155551212",
      },
    ]);
    const res = await request(makeApp()).post(
      "/admin/smart-triggers/send-due?channel=sms",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 1,
      failed: 0,
      skippedNoPhone: 0,
      skippedNoContact: 0,
      channel: "sms",
    });
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const smsCall = sendSmsMock.mock.calls[0]?.[0] as {
      to: string;
      body: string;
    };
    expect(smsCall.to).toBe("+12155551212");
    expect(smsCall.body).toContain("STOP");
    expect(smsCall.body).toContain("cushion");
    // Single Twilio segment in the typical case.
    expect(smsCall.body.length).toBeLessThanOrEqual(160);

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.channel).toBe("sms");
    const auditJson = JSON.stringify(audit);
    // PHI invariant: phone number never appears in the envelope.
    // (kind=`cushion_wear` IS legitimately structural metadata —
    // we audit which trigger fired but never the rendered body.)
    expect(auditJson).not.toContain("+12155551212");
    expect(auditJson).not.toContain("STOP");
    expect(auditJson).not.toContain("Penn Home");
  });

  it("skips rows without a phone on the SMS channel", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        eventId: "evt_1",
        patientId: "p_1",
        kind: "leak_rising",
        windowStartDate: "2026-04-15",
        windowEndDate: "2026-04-29",
        firstName: "Anna",
        email: "anna@example.com",
        phoneE164: null,
      },
    ]);
    const res = await request(makeApp()).post(
      "/admin/smart-triggers/send-due?channel=sms",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 0,
      skippedNoPhone: 1,
      skippedNoContact: 1,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(updateSets).toEqual([]);
  });
});
