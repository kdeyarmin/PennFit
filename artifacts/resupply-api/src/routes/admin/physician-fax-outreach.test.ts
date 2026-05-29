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

// Mock signFaxDocumentToken so it doesn't need the HMAC key in tests.
vi.mock("../../lib/fax-document-token", () => ({
  signFaxDocumentToken: () => "test-fax-token",
}));

// Fax client mock — captures sendFax calls.
const sendFaxMock = vi.fn<() => Promise<{ sid: string; status: string }>>(
  async () => ({ sid: "FX_test_sid", status: "queued" }),
);
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioFaxClient: () => ({ sendFax: sendFaxMock }),
  };
});

import physicianFaxOutreachRouter from "./physician-fax-outreach";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(physicianFaxOutreachRouter);
  return app;
}

const ADMIN_EMAIL = "ops@penn.example.com";
const PATIENT_ID = "11111111-2222-4333-8444-555555555555";
const PRESCRIPTION_ID = "66666666-7777-4888-9999-aaaaaaaaaaaa";
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
  supabaseMock.reset();
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
    stageSupabaseResponse("patients", "select", { data: null });
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("400s when prescription doesn't belong to patient", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("prescriptions", "select", {
      data: { id: PRESCRIPTION_ID, patient_id: "different_patient" },
    });
    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send({ ...VALID_BODY, prescriptionId: PRESCRIPTION_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("prescription_patient_mismatch");
  });

  it("201s + inserts + audits with non-PHI envelope (no Twilio config)", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("physician_fax_outreach", "insert", {
      data: { id: "out_xyz" },
    });

    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "out_xyz",
      status: "pending",
      provider: "not_configured",
    });

    const inserts = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "insert",
    ) as Record<string, unknown>[];
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      patient_id: PATIENT_ID,
      physician_name: "Dr. Anna Stein",
      physician_fax_e164: "+12155551212",
      created_by_email: ADMIN_EMAIL,
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
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("physician_fax_outreach", "insert", {
      data: { id: "out_xyz" },
    });
    // Post-send stamp.
    stageSupabaseResponse("physician_fax_outreach", "update", { error: null });

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
      Array<{
        to: string;
        from: string;
        mediaUrl: string;
        statusCallbackUrl: string;
      }>
    >;
    const faxCall = faxCallArgs[0]![0]!;
    expect(faxCall.to).toBe("+12155551212");
    expect(faxCall.from).toBe("+12155550000");
    expect(faxCall.mediaUrl).toContain(
      "https://api.example.test/resupply-api/fax/document/",
    );
    expect(faxCall.statusCallbackUrl).toBe(
      "https://api.example.test/resupply-api/fax/status-callback",
    );

    const updates = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "sent",
      vendor_ref: "FX_test_sid",
      vendor_name: "twilio",
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
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("physician_fax_outreach", "insert", {
      data: { id: "out_fail" },
    });
    // Failure-stamp update.
    stageSupabaseResponse("physician_fax_outreach", "update", { error: null });

    const res = await request(makeApp())
      .post("/admin/physician-fax-outreach")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("failed");
    expect(res.body.provider).toBe("twilio");
    expect(typeof res.body.dispatchError).toBe("string");

    const updates = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    ) as Record<string, unknown>[];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "failed" });
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
    stageSupabaseResponse("physician_fax_outreach", "select", {
      data: [
        {
          id: "out_1",
          patient_id: PATIENT_ID,
          prescription_id: null,
          physician_name: "Dr. A",
          physician_fax_e164: "+12155551212",
          status: "pending",
          vendor_ref: null,
          vendor_name: null,
          sent_at: null,
          delivered_at: null,
          failed_at: null,
          failure_reason: null,
          created_by_email: ADMIN_EMAIL,
          created_at: new Date("2026-04-30T12:00:00Z").toISOString(),
        },
      ],
    });
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
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("physician_fax_outreach", "select", { data: [] });

    const res = await request(makeApp()).get(
      `/admin/physician-fax-outreach?patientId=${PATIENT_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.providerConfigured).toBe(true);
  });
});

describe("POST /admin/physician-fax-outreach/:id/retry", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/out_1/retry",
    );
    expect(res.status).toBe(401);
  });

  it("503s when Twilio is not configured", async () => {
    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/out_1/retry",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("fax_not_configured");
  });

  it("404s when outreach row not found", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("physician_fax_outreach", "select", { data: null });

    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/no-such-id/retry",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("outreach_not_found");
  });

  it("409s when row is already sent (double-billing guard)", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("physician_fax_outreach", "select", {
      data: {
        id: "out_1",
        status: "sent",
        physician_fax_e164: "+12155551212",
        patient_id: PATIENT_ID,
      },
    });

    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/out_1/retry",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_dispatched");
    expect(sendFaxMock).not.toHaveBeenCalled();
  });

  it("409s when row is already delivered", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("physician_fax_outreach", "select", {
      data: {
        id: "out_1",
        status: "delivered",
        physician_fax_e164: "+12155551212",
        patient_id: PATIENT_ID,
      },
    });

    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/out_1/retry",
    );
    expect(res.status).toBe(409);
    expect(sendFaxMock).not.toHaveBeenCalled();
  });

  it("retries a failed row and returns status=sent", async () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "token_test";
    process.env.TWILIO_FAX_FROM_NUMBER = "+12155550000";
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL = "https://api.example.test";

    mockAdmin.current = { userId: "u", email: ADMIN_EMAIL, role: "admin" };
    stageSupabaseResponse("physician_fax_outreach", "select", {
      data: {
        id: "out_1",
        status: "failed",
        physician_fax_e164: "+12155551212",
        patient_id: PATIENT_ID,
      },
    });
    // Optimistic-concurrency claim (updates updated_at) + post-send
    // status stamp.
    stageSupabaseResponse("physician_fax_outreach", "update", {
      data: { id: "out_1" },
    });
    stageSupabaseResponse("physician_fax_outreach", "update", { error: null });

    const res = await request(makeApp()).post(
      "/admin/physician-fax-outreach/out_1/retry",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "out_1",
      status: "sent",
      provider: "twilio",
    });

    expect(sendFaxMock).toHaveBeenCalledOnce();
    const updates = getSupabaseWritePayloads(
      "physician_fax_outreach",
      "update",
    ) as Record<string, unknown>[];
    // updates[0] is the optimistic-concurrency claim (just touches
    // updated_at); updates[1] is the post-send status stamp.
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      status: "sent",
      vendor_ref: "FX_test_sid",
      vendor_name: "twilio",
    });
  });
});
