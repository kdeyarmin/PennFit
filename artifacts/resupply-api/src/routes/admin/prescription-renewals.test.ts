// Route tests for /admin/prescriptions/send-renewal-due (Phase B.2).
//
// Coverage:
//   * 401 without admin
//   * 503 when SendGrid is not configured
//   * Sends + stamps + audits with non-PHI envelope
//   * Skips rows with no email; counts increment correctly
//   * SendGrid throw → counted as failed; row unclaimed for retry

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import prescriptionRenewalsRouter from "./prescription-renewals";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(prescriptionRenewalsRouter);
  return app;
}

beforeEach(() => {
  // Pin the clock inside the 9am-8pm patient-local TCPA send window
  // (17:00 UTC = 1pm ET) -- the dispatchers gate-skip SMS outside it,
  // so an unpinned clock made these tests fail by wall-clock hour.
  vi.useFakeTimers({ now: new Date("2026-06-01T17:00:00Z"), toFake: ["Date"] });

  afterEach(() => {
    vi.useRealTimers();
  });
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
  sendEmailMock.mockClear();
  sendEmailMock.mockResolvedValue({ messageId: "sg_1" });
  sendgridConfigured.current = true;
  sendSmsMock.mockClear();
  sendSmsMock.mockResolvedValue({ messageSid: "SM_1" });
  twilioConfigured.current = true;
  sendPushToCustomerByEmailMock.mockClear();
});

describe("POST /admin/prescriptions/send-renewal-due", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );
    expect(res.status).toBe(401);
  });

  it("503s when SendGrid is not configured", async () => {
    mockAdmin.current = ADMIN;
    sendgridConfigured.current = false;
    // The dispatcher reads candidates + patients first, then tries
    // to construct the SendGrid client. Stage both upfront so the
    // chain reaches the gate.
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("email_not_configured");
  });

  it("sends + stamps + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    const inFiveDaysIso = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx_1",
          patient_id: "p_1",
          valid_until: inFiveDaysIso,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Anna",
          email: "anna@example.com",
          phone_e164: null,
        },
      ],
    });
    // Atomic claim — UPDATE … RETURNING returns the claimed row.
    stageSupabaseResponse("prescriptions", "update", {
      data: { id: "rx_1" },
    });

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

    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(typeof updates[0]?.renewal_requested_at).toBe("string");

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("prescription.renewal_requested");
    expect(audit.metadata.patient_id).toBe("p_1");
    expect(audit.metadata.channel).toBe("email");
    expect(typeof audit.metadata.days_until_expiry).toBe("number");
    expect(audit.metadata.days_until_expiry).toBeGreaterThanOrEqual(4);
    expect(audit.metadata.days_until_expiry).toBeLessThanOrEqual(5);

    // Phase G.9 — push fan-out by email lookup runs alongside the
    // email send. Best-effort: the helper itself returns {0,0,0}
    // when no matching shop_customers row exists.
    expect(sendPushToCustomerByEmailMock).toHaveBeenCalledTimes(1);
    const [pushEmail, pushPayload] =
      sendPushToCustomerByEmailMock.mock.calls[0]!;
    expect(pushEmail).toBe("anna@example.com");
    expect(pushPayload.url).toBe("/account");
    expect(pushPayload.tag).toMatch(/^rx_renewal:/);
    expect(pushPayload.title).toMatch(/Rx expires/);
  });

  it("skips rows without an email + does not stamp", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx_1",
          patient_id: "p_1",
          valid_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Anna",
          email: null,
          phone_e164: null,
        },
      ],
    });

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
    expect(getSupabaseWritePayloads("prescriptions", "update")).toEqual([]);
  });

  it("counts SendGrid throws as failed and unclaims for retry", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx_1",
          patient_id: "p_1",
          valid_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Anna",
          email: "anna@example.com",
          phone_e164: null,
        },
      ],
    });
    // Atomic claim succeeds.
    stageSupabaseResponse("prescriptions", "update", {
      data: { id: "rx_1" },
    });
    // Unclaim after the SendGrid failure.
    stageSupabaseResponse("prescriptions", "update", { error: null });
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
    // Two updates: the claim and the unclaim. Row stays eligible
    // for the next cron tick.
    const updates = getSupabaseWritePayloads(
      "prescriptions",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(2);
    expect(typeof updates[0]?.renewal_requested_at).toBe("string");
    expect(updates[1]?.renewal_requested_at).toBeNull();
    // Audit only logs successful sends.
    expect(logAuditMock).not.toHaveBeenCalled();
  });
});

describe("POST /admin/prescriptions/send-renewal-due?channel=sms (Phase G.3)", () => {
  it("503s with sms_not_configured when Twilio is missing", async () => {
    mockAdmin.current = ADMIN;
    twilioConfigured.current = false;
    stageSupabaseResponse("prescriptions", "select", { data: [] });
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due?channel=sms",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sms_not_configured");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("400s on invalid channel value", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due?channel=carrier-pigeon",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_channel");
  });

  it("sends SMS + stamps + audits with channel=sms; never logs the body", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx_1",
          patient_id: "p_1",
          valid_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Anna",
          email: null,
          phone_e164: "+12155551212",
        },
      ],
    });
    stageSupabaseResponse("prescriptions", "update", {
      data: { id: "rx_1" },
    });

    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due?channel=sms",
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
    expect(smsCall.body).toContain("CPAP Rx");
    expect(smsCall.body).toContain("STOP");

    const updates = getSupabaseWritePayloads("prescriptions", "update");
    expect(updates).toHaveLength(1);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(audit.metadata.channel).toBe("sms");
    expect(audit.metadata.patient_id).toBe("p_1");
    // Audit envelope never includes the SMS body or phone number.
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("+12155551212");
    expect(auditJson).not.toContain("CPAP Rx");
  });

  it("skips rows without a phone number on the SMS channel", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescriptions", "select", {
      data: [
        {
          id: "rx_1",
          patient_id: "p_1",
          valid_until: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: "p_1",
          legal_first_name: "Anna",
          email: "anna@example.com",
          phone_e164: null,
        },
      ],
    });
    const res = await request(makeApp()).post(
      "/admin/prescriptions/send-renewal-due?channel=sms",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      sent: 0,
      skippedNoPhone: 1,
      skippedNoContact: 1,
    });
    // Email channel is intentionally untouched even though email is set.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(getSupabaseWritePayloads("prescriptions", "update")).toEqual([]);
  });
});
