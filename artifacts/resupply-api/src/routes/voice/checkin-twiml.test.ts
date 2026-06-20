// Route tests for POST /voice/checkin-press (the IVR "press 1 for a
// callback" leg). The signature middleware is replaced with a passthrough —
// the algorithm is covered in lib/resupply-telecom/src/signature.test.ts.
//
// Focus: the tenant is derived FROM the patient record (the patient id rode
// in the signed TwiML URL), NOT the seed org, so a non-seed tenant's check-in
// call resolves its own patient and files the callback alert.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    requireTwilioSignature:
      () =>
      (_req: unknown, _res: unknown, next: (err?: unknown) => void): void =>
        next(),
  };
});

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({ logAudit: logAuditMock }));

import checkinTwimlRouter from "./checkin-twiml";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_B = "00000000-0000-4000-8000-000000000002";

function makeApp(): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(checkinTwimlRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  logAuditMock.mockClear();
  process.env.TWILIO_AUTH_TOKEN = "test-token";
});

describe("POST /voice/checkin-press", () => {
  it("files a callback alert under the patient's own tenant (not the seed org)", async () => {
    // 1) resolveOrgIdForSignedRecord reads the patient's org_id first.
    stageSupabaseResponse("patients", "select", { data: { org_id: ORG_B } });
    // 2) the handler's own patient-exists check.
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    // 3) the alert insert.
    stageSupabaseResponse("csr_compliance_alerts", "insert", {
      data: { id: "alert-1" },
    });

    const res = await request(makeApp())
      .post(`/voice/checkin-press?patientId=${PATIENT_ID}&day=monday`)
      .type("form")
      .send({ Digits: "1", CallSid: "CA1" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("call you back");
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(1);
    const [alert] = getSupabaseWritePayloads(
      "csr_compliance_alerts",
      "insert",
    ) as Array<Record<string, unknown>>;
    expect(alert.patient_id).toBe(PATIENT_ID);
    // The org-scoped facade tags the insert with the org derived from the
    // patient record — proving the alert lands in the patient's tenant.
    expect(alert.org_id).toBe(ORG_B);
  });

  it("hangs up without filing an alert when the caller did not press 1", async () => {
    const res = await request(makeApp())
      .post(`/voice/checkin-press?patientId=${PATIENT_ID}&day=monday`)
      .type("form")
      .send({ Digits: "9" });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Goodbye");
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(0);
  });

  it("hangs up when the patient can't be resolved", async () => {
    // org-resolution miss → seed fallback; the scoped exists-check then
    // finds nothing.
    stageSupabaseResponse("patients", "select", { data: null });
    stageSupabaseResponse("patients", "select", { data: null });

    const res = await request(makeApp())
      .post(`/voice/checkin-press?patientId=${PATIENT_ID}&day=monday`)
      .type("form")
      .send({ Digits: "1" });

    expect(res.status).toBe(200);
    expect(getSupabaseCallCount("csr_compliance_alerts", "insert")).toBe(0);
  });
});
