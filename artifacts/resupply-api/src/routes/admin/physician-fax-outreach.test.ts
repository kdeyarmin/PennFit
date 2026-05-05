// Route tests for /admin/physician-fax-outreach (Phase G.6).
//
// Coverage:
//   * 401 without admin
//   * 400 on bad body shape (E.164, length, missing fields)
//   * 404 when patient doesn't exist
//   * 400 when prescription doesn't belong to the patient
//   * 201 happy path: row inserted, audit envelope is non-PHI
//   * 201 with Twilio dispatch when all three env vars are set
//   * GET ?patientId=… returns rows scoped to that patient
//   * `providerConfigured` reflects TWILIO_* env vars
//
// PHI invariant under test: the audit metadata never contains the
// fax number, physician name, or cover-letter body.

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

// Mock signFaxDocumentToken so it doesn't need the HMAC key in tests.
vi.mock("../../lib/fax-document-token", () => ({
  signFaxDocumentToken: () => "test-fax-token",
}));

// Fax client mock — captures sendFax calls.
const sendFaxMock = vi.fn<() => Promise<{ sid: string; status: string }>>(
  async () => ({ sid: "FX_test_sid", status: "queued" }),
);
vi.mock("@workspace/resupply-telecom", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/resupply-telecom")>(
      "@workspace/resupply-telecom",
    );
  return {
    ...actual,
    createTwilioFaxClient: () => ({ sendFax: sendFaxMock }),
  };
});

const selectQueue: unknown[][] = [];
const insertReturnQueue: unknown[][] = [];
const insertedValues: Record<string, unknown>[] = [];
const updatedSets: Record<string, unknown>[] = [];

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
    const obj: Record<string, unknown> = {
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return obj;
      },
      returning: () =>
        Promise.resolve(insertReturnQueue.shift() ?? [{ id: "out_1" }]),
    };
    return obj;
  }),
  update: vi.fn(() => {
    const obj: Record<string, unknown> = {
      set: (vals: Record<string, unknown>) => {
        updatedSets.push(vals);
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

import physicianFaxOutreachRouter from "./physician-fax-outreach";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(physicianFaxOutreachRouter);
  return app;
}

const ADMIN_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-2222-3333-4444-555555555555";
const PRESCRIPTION_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const VALID_BODY = {
  patientId: PATIENT_ID,
  physicianName: "Dr. Anna Stein",
  physicianFaxE164: "+12155551212",
  coverLetterText:
    "Please renew the prescription for the patient below — sent on behalf of Penn Home Medical Supply.",
};

const TWILIO_FAX_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FAX_FROM_NUMBER",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
] as const;

const originalEnv: Partial<
  Record<(typeof TWILIO_FAX_ENV_KEYS)[number], string | undefined>
> = {};

beforeEach(() => {
  for (const k of TWILIO_FAX_ENV_KEYS) originalEnv[k] = process.env[k];
  for (const k of TWILIO_FAX_ENV_KEYS) delete process.env[k];
  mockAdmin.current = null;
  selectQueue.length = 0;
  insertReturnQueue.length = 0;
  insertedValues.length = 0;
  updatedSets.length = 0;
  sendFaxMock.mockClear();
  logAuditMock.mockClear();
});
afterEach(() => {
  for (const k of TWILIO_FAX_ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe("POST /admin/physician-fax-outreach", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it("400s on bad fax format", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([{ id: PATIENT_ID }]);
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send({ ...VALID_BODY, physicianFaxE164: "215-555-1212" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("400s on too-short cover letter", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send({ ...VALID_BODY, coverLetterText: "too short" });
    expect(res.status).toBe(400);
  });

  it("404s when patient doesn't exist", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([]); // patient lookup
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("400s when prescription doesn't belong to patient", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([{ id: PATIENT_ID }]); // patient
    selectQueue.push([{ id: PRESCRIPTION_ID, patientId: "different_patient" }]); // rx
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send({ ...VALID_BODY, prescriptionId: PRESCRIPTION_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("prescription_patient_mismatch");
  });

  it("201s + inserts + audits with non-PHI envelope (no Twilio config)", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([{ id: PATIENT_ID }]); // patient lookup
    insertReturnQueue.push([{ id: "out_xyz" }]);

    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "out_xyz",
      status: "pending",
      provider: "not_configured",
    });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      patientId: PATIENT_ID,
      physicianName: "Dr. Anna Stein",
      physicianFaxE164: "+12155551212",
      createdByEmail: ADMIN_EMAIL,
    });

    expect(sendFaxMock).not.toHaveBeenCalled();

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("physician_fax_outreach.created");
    expect(audit.metadata.patient_id).toBe(PATIENT_ID);
    expect(audit.metadata.has_prescription).toBe(false);
    expect(typeof audit.metadata.cover_letter_length).toBe("number");
    // PHI invariant — none of the body content reaches the envelope.
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("Anna Stein");
    expect(auditJson).not.toContain("+12155551212");
    expect(auditJson).not.toContain("renew the prescription");
  });

  it("dispatches via Twilio and returns status=sent when env vars are set", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([{ id: PATIENT_ID }]);
    insertReturnQueue.push([{ id: "out_xyz" }]);

    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "out_xyz",
      status: "sent",
      provider: "twilio",
    });

    expect(sendFaxMock).toHaveBeenCalledOnce();
    const faxCallArgs = sendFaxMock.mock.calls as unknown as Array<
      Array<{ to: string; from: string; mediaUrl: string; statusCallbackUrl: string }>
    >;
    const faxCall = faxCallArgs[0]![0]!;
    expect(faxCall.to).toBe("+12155551212");
    expect(faxCall.from).toBe("+12155550000");
    expect(faxCall.mediaUrl).toContain(
      "https://api.example.test/fax/document/",
    );
    expect(faxCall.statusCallbackUrl).toBe(
      "https://api.example.test/fax/status-callback",
    );

    // DB update stamps vendor_ref + status='sent'
    expect(updatedSets).toHaveLength(1);
    expect(updatedSets[0]).toMatchObject({
      status: "sent",
      vendorRef: "FX_test_sid",
      vendorName: "twilio",
    });
  });

  it("returns status=failed and stamps DB when Twilio throws", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    sendFaxMock.mockRejectedValueOnce(
      Object.assign(new Error("Twilio 400"), { name: "TwilioApiError" }),
    );

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([{ id: PATIENT_ID }]);
    insertReturnQueue.push([{ id: "out_fail" }]);

    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("failed");
    expect(res.body.provider).toBe("twilio");
    expect(typeof res.body.dispatchError).toBe("string");

    expect(updatedSets).toHaveLength(1);
    expect(updatedSets[0]).toMatchObject({ status: "failed" });
  });
});

describe("GET /admin/physician-fax-outreach", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/physician-fax-outreach?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("400s without patientId", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    const res = await request(makeApp()).get("/admin/physician-fax-outreach");
    expect(res.status).toBe(400);
  });

  it("returns scoped rows + providerConfigured flag (unconfigured)", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([
      {
        id: "out_1",
        patientId: PATIENT_ID,
        prescriptionId: null,
        physicianName: "Dr. A",
        physicianFaxE164: "+12155551212",
        status: "pending",
        vendorRef: null,
        vendorName: null,
        sentAt: null,
        deliveredAt: null,
        failedAt: null,
        failureReason: null,
        createdByEmail: ADMIN_EMAIL,
        createdAt: new Date("2026-04-30T12:00:00Z"),
      },
    ]);
    const res = await request(makeApp()).get(
      `/admin/physician-fax-outreach?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.outreach).toHaveLength(1);
    expect(res.body.outreach[0].id).toBe("out_1");
    expect(res.body.outreach[0].createdAt).toBe("2026-04-30T12:00:00.000Z");
    expect(res.body.providerConfigured).toBe(false);
  });

  it("returns providerConfigured=true when Twilio vars are set", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    selectQueue.push([]);

    const res = await request(makeApp()).get(
      `/admin/physician-fax-outreach?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.providerConfigured).toBe(true);
  });
});
