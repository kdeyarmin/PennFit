// Route tests for /admin/patients/:id/onboarding (Phase B.1).
//
// Coverage:
//   * 401 without admin
//   * GET returns null when no journey exists
//   * POST enroll inserts + audits with non-PHI envelope; 409 on
//     re-enroll while one is active
//   * Dispatcher fires the next-due check-in, stamps the timestamp,
//     and transitions to 'completed' on day-90

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
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => ({ sendEmail: sendEmailMock }),
  };
});

import patientOnboardingRouter from "./patient-onboarding";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(patientOnboardingRouter);
  return app;
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // Pin the clock inside the 9am-8pm patient-local TCPA send window
  // (17:00 UTC = 1pm ET) -- the dispatchers gate-skip SMS outside it,
  // so an unpinned clock made these tests fail by wall-clock hour.
  vi.useFakeTimers({ now: new Date("2026-06-01T17:00:00Z"), toFake: ["Date"] });
  mockAdmin.current = null;
  supabaseMock.reset();
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
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: null,
    });
    const res = await request(makeApp()).get(
      `/admin/patients/${PATIENT_ID}/onboarding`,
    );
    expect(res.status).toBe(200);
    expect(res.body.journey).toBeNull();
  });
});

describe("POST /admin/patients/:id/onboarding/enroll", () => {
  it("409s when an active journey already exists", async () => {
    mockAdmin.current = ADMIN;
    // Patient exists + an active journey already → 409.
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: { id: "j_existing" },
    });
    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/onboarding/enroll`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_enrolled");
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: null,
    });
    stageSupabaseResponse("patient_onboarding_journeys", "insert", {
      data: {
        id: "j_new",
        started_at: new Date("2026-05-04T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/admin/patients/${PATIENT_ID}/onboarding/enroll`)
      .send({ startedAt: "2026-05-04T12:00:00Z" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("j_new");
    const inserts = getSupabaseWritePayloads(
      "patient_onboarding_journeys",
      "insert",
    ) as Record<string, unknown>[];
    expect(inserts[0]?.patient_id).toBe(PATIENT_ID);

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
  it("fires the next due check-in via email, stamps, and audits", async () => {
    mockAdmin.current = ADMIN;
    // One active journey, started 8 days ago — day3 already sent,
    // day7 still null and now due.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: [
        {
          id: "j_1",
          patient_id: PATIENT_ID,
          started_at: eightDaysAgo.toISOString(),
          day1_sent_at: null,
          day3_sent_at: new Date(
            eightDaysAgo.getTime() + 3 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          day7_sent_at: null,
          day30_sent_at: null,
          day60_sent_at: null,
          day90_sent_at: null,
        },
      ],
    });
    // Bulk patient lookup — single batch.
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Anna",
          email: "anna@example.com",
          phone_e164: null,
          channel_preference: null,
        },
      ],
    });
    // Stamp + status update on the journey row, plus the
    // patient_checkin_attempts insert. Stage them with permissive
    // empties — the dispatcher only checks for `error`.
    stageSupabaseResponse("patient_checkin_attempts", "insert", {
      error: null,
    });
    stageSupabaseResponse("patient_onboarding_journeys", "update", {
      error: null,
    });

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      delivered: 1,
      failed: 0,
      skippedNoContact: 0,
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

    // Stamp lands on the journey row using the snake_case column
    // name PostgREST expects.
    const updates = getSupabaseWritePayloads(
      "patient_onboarding_journeys",
      "update",
    ) as Record<string, unknown>[];
    const stampUpdate = updates.find((u) => "day7_sent_at" in u);
    expect(stampUpdate).toBeDefined();
    expect(typeof stampUpdate?.day7_sent_at).toBe("string");
    expect(stampUpdate?.status).toBeUndefined();

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
    expect(sentAudit?.metadata).toMatchObject({
      patient_id: PATIENT_ID,
      day_label: "day7",
      channel: "email",
      outcome: "sent",
    });
  });

  it("transitions journey to completed after day-90", async () => {
    mockAdmin.current = ADMIN;
    const ninetyOneDaysAgo = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const isoNow = new Date().toISOString();
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: [
        {
          id: "j_1",
          patient_id: PATIENT_ID,
          started_at: ninetyOneDaysAgo.toISOString(),
          day1_sent_at: null,
          day3_sent_at: isoNow,
          day7_sent_at: isoNow,
          day30_sent_at: isoNow,
          day60_sent_at: isoNow,
          day90_sent_at: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Anna",
          email: "anna@example.com",
          phone_e164: null,
          channel_preference: null,
        },
      ],
    });
    stageSupabaseResponse("patient_checkin_attempts", "insert", {
      error: null,
    });
    stageSupabaseResponse("patient_onboarding_journeys", "update", {
      error: null,
    });

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.completedJourneys).toBe(1);
    const updates = getSupabaseWritePayloads(
      "patient_onboarding_journeys",
      "update",
    ) as Record<string, unknown>[];
    // Stamp uses the snake_case column name PostgREST expects.
    const stampUpdate = updates.find((u) => "day90_sent_at" in u);
    expect(stampUpdate).toBeDefined();
    expect(stampUpdate?.status).toBe("completed");

    const auditActions = logAuditMock.mock.calls.map(
      (c) => (c[0] as { action: string }).action,
    );
    expect(auditActions).toContain("patient.onboarding.checkin_sent");
    expect(auditActions).toContain("patient.onboarding.complete");
  });

  it("skips rows without any contact channel", async () => {
    mockAdmin.current = ADMIN;
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    stageSupabaseResponse("patient_onboarding_journeys", "select", {
      data: [
        {
          id: "j_1",
          patient_id: PATIENT_ID,
          started_at: eightDaysAgo.toISOString(),
          day1_sent_at: null,
          day3_sent_at: new Date(
            eightDaysAgo.getTime() + 3 * 24 * 60 * 60 * 1000,
          ).toISOString(),
          day7_sent_at: null,
          day30_sent_at: null,
          day60_sent_at: null,
          day90_sent_at: null,
        },
      ],
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          id: PATIENT_ID,
          legal_first_name: "Anna",
          email: null,
          phone_e164: null,
          channel_preference: null,
        },
      ],
    });

    const res = await request(makeApp())
      .post("/admin/onboarding/send-due")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      attempted: 1,
      delivered: 0,
      skippedNoContact: 1,
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
    // No stamp update because no channel succeeded.
    const updates = getSupabaseWritePayloads(
      "patient_onboarding_journeys",
      "update",
    ) as Record<string, unknown>[];
    const stampUpdate = updates.find((u) =>
      Object.keys(u).some(
        (k) => k.endsWith("_sent_at") || k.endsWith("SentAt"),
      ),
    );
    expect(stampUpdate).toBeUndefined();
  });
});
