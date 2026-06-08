// Route tests for the staff AI mask-fitter invite endpoints.
//
// Coverage:
//   POST /admin/fitter-invites
//     * prospect mode (email) → 201, inserts a row, returns a link
//     * patient mode → resolves contact from the chart
//     * channel/contact mismatch → 422
//     * invalid body → 400
//   POST /admin/fitter-invites/:id/attach
//     * attach to existing patient → 200 status:attached
//     * attach a non-completed invite → 409
//   DELETE /admin/fitter-invites/:id → 200 status:revoked

import { describe, it, expect, vi, beforeEach } from "vitest";
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

// Email/SMS clients degrade to "not configured" in the test env, so
// delivery returns delivered:false but the row + link are still made.
vi.mock("@workspace/resupply-email", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-email")
  >("@workspace/resupply-email");
  return {
    ...actual,
    createSendgridClient: () => {
      throw new actual.EmailConfigError("no key in test");
    },
  };
});
vi.mock("@workspace/resupply-telecom", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-telecom")
  >("@workspace/resupply-telecom");
  return {
    ...actual,
    createTwilioSmsClient: () => {
      throw new actual.TwilioConfigError("no creds in test");
    },
  };
});

import fitterInvitesRouter from "./fitter-invites";

const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", fitterInvitesRouter);
  return app;
}

beforeEach(() => {
  supabaseMock.reset();
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@penn.example.com",
    role: "admin",
  };
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
  process.env.SHOP_PUBLIC_BASE_URL = "https://pennpaps.example.com";
});

describe("POST /admin/fitter-invites", () => {
  it("creates a prospect invite by email and returns a link", async () => {
    stageSupabaseResponse("fitter_invites", "insert", {
      data: { id: INVITE_ID },
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/fitter-invites")
      .send({ email: "prospect@example.com", channel: "email" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(INVITE_ID);
    expect(res.body.channel).toBe("email");
    expect(res.body.inviteLink).toContain(
      "https://pennpaps.example.com/fitter-invite?t=",
    );
    // No email configured in test → delivered:false, link still given.
    expect(res.body.delivered).toBe(false);

    const writes = getSupabaseWritePayloads("fitter_invites", "insert");
    expect(writes).toHaveLength(1);
    const row = writes[0] as Record<string, unknown>;
    expect(row.recipient_email).toBe("prospect@example.com");
    expect(row.channel).toBe("email");
    expect(row.status).toBe("sent");
    expect(row.patient_id).toBeNull();
  });

  it("resolves contact from the patient chart in patient mode", async () => {
    stageSupabaseResponse("patients", "select", {
      data: {
        id: PATIENT_ID,
        email: "chart@example.com",
        phone_e164: "+12155551234",
        legal_first_name: "Jordan",
        legal_last_name: "Lee",
      },
    });
    stageSupabaseResponse("fitter_invites", "insert", {
      data: { id: INVITE_ID },
    });
    const res = await request(makeApp())
      .post("/resupply-api/admin/fitter-invites")
      .send({ patientId: PATIENT_ID, channel: "sms" });
    expect(res.status).toBe(201);
    const writes = getSupabaseWritePayloads("fitter_invites", "insert");
    const row = writes[0] as Record<string, unknown>;
    expect(row.patient_id).toBe(PATIENT_ID);
    expect(row.recipient_phone_e164).toBe("+12155551234");
    expect(row.recipient_name).toBe("Jordan Lee");
    expect(row.channel).toBe("sms");
  });

  it("422s when the chosen channel has no contact", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/admin/fitter-invites")
      .send({ email: "p@example.com", channel: "sms" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("phone_required");
  });

  it("400s on an invalid body", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/admin/fitter-invites")
      .send({ channel: "carrier-pigeon" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});

describe("POST /admin/fitter-invites/:id/attach", () => {
  it("attaches a completed invite to an existing patient", async () => {
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "completed",
        recipient_email: "p@example.com",
        recipient_phone_e164: null,
      },
    });
    stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/fitter-invites/${INVITE_ID}/attach`)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("attached");
    expect(res.body.patientId).toBe(PATIENT_ID);
  });

  it("builds a new chart and enrolls it in the onboarding flow", async () => {
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "completed",
        recipient_email: "newprospect@example.com",
        recipient_phone_e164: "+12155559876",
      },
    });
    stageSupabaseResponse("patients", "insert", { data: { id: PATIENT_ID } });
    stageSupabaseResponse("patient_onboarding_journeys", "insert", {
      data: null,
    });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/fitter-invites/${INVITE_ID}/attach`)
      .send({
        createPatient: {
          legalFirstName: "Sam",
          legalLastName: "Rivera",
          dateOfBirth: "1980-04-15",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("attached");
    expect(res.body.patientId).toBe(PATIENT_ID);
    expect(res.body.enrolledInOnboarding).toBe(true);

    const patientWrite = getSupabaseWritePayloads(
      "patients",
      "insert",
    )[0] as Record<string, unknown>;
    expect(patientWrite.legal_first_name).toBe("Sam");
    expect(patientWrite.email).toBe("newprospect@example.com");
    const journeyWrite = getSupabaseWritePayloads(
      "patient_onboarding_journeys",
      "insert",
    )[0] as Record<string, unknown>;
    expect(journeyWrite.patient_id).toBe(PATIENT_ID);
  });

  it("409s when the invite is not completed", async () => {
    stageSupabaseResponse("fitter_invites", "select", {
      data: { id: INVITE_ID, status: "sent" },
    });
    const res = await request(makeApp())
      .post(`/resupply-api/admin/fitter-invites/${INVITE_ID}/attach`)
      .send({ patientId: PATIENT_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_completed");
  });
});

describe("DELETE /admin/fitter-invites/:id", () => {
  it("revokes an outstanding invite", async () => {
    stageSupabaseResponse("fitter_invites", "select", {
      data: { id: INVITE_ID, status: "sent" },
    });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp()).delete(
      `/resupply-api/admin/fitter-invites/${INVITE_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("revoked");
  });
});
