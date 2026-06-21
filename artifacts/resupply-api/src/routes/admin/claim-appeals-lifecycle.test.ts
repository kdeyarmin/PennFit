// Tests for the appeal lifecycle routes added in this change:
//   POST .../appeal-letter/:letterId/mark-delivered  (mail/email/portal)
//   POST .../appeal-letter/:letterId/outcome         (payer response)

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
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));
vi.mock("../../lib/webhooks/publisher", () => ({
  publishEvent: vi.fn(async () => undefined),
}));
vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8"),
}));
vi.mock("./physician-fax-outreach", () => ({
  isFaxConfigured: () => true,
  getFaxPublicBaseUrl: () => "https://app.example.com",
  default: {},
}));
vi.mock("@workspace/resupply-telecom", () => ({
  createTelnyxFaxClient: () => ({ sendFax: vi.fn() }),
  TelnyxApiError: class extends Error {},
}));

import claimAppealsRouter from "./claim-appeals";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "biller@penn.example.com",
  role: "admin",
};
const PID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const LETTER_ID = "33333333-3333-4333-8333-333333333333";
const ANALYSIS_ID = "44444444-4444-4444-8444-444444444444";
const base = `/admin/patients/${PID}/insurance-claims/${CLAIM_ID}/appeal-letter/${LETTER_ID}`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(claimAppealsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("POST .../mark-delivered", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp())
      .post(`${base}/mark-delivered`)
      .send({ deliveryMethod: "mail" });
    expect(res.status).toBe(401);
  });

  it("404 when the letter belongs to another claim", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: "99999999-9999-4999-8999-999999999999" },
    });
    const res = await request(makeApp())
      .post(`${base}/mark-delivered`)
      .send({ deliveryMethod: "mail" });
    expect(res.status).toBe(404);
  });

  it("stamps delivery + transitions a denied claim to appealed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: {
        id: LETTER_ID,
        claim_id: CLAIM_ID,
        denial_analysis_id: ANALYSIS_ID,
        delivered_at: null,
      },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID, status: "denied" },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null }); // stamp
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_ID }],
    }); // transition
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    stageSupabaseResponse("claim_denial_analyses", "update", { data: null });

    const res = await request(makeApp())
      .post(`${base}/mark-delivered`)
      .send({ deliveryMethod: "mail" });

    expect(res.status).toBe(200);
    // delivery stamped
    const stamp = supabaseMock.writePayloads(
      "claim_appeal_letters",
      "update",
    )[0] as Record<string, unknown> | undefined;
    expect(stamp?.delivery_method).toBe("mail");
    expect(stamp?.delivered_at).toBeTruthy();
    // claim transitioned
    const claimUpd = supabaseMock.writePayloads(
      "insurance_claims",
      "update",
    )[0] as Record<string, unknown> | undefined;
    expect(claimUpd?.status).toBe("appealed");
  });

  it("does not transition a non-denied claim but still stamps delivery", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: {
        id: LETTER_ID,
        claim_id: CLAIM_ID,
        denial_analysis_id: null,
        delivered_at: null,
      },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID, status: "submitted" },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null });

    const res = await request(makeApp())
      .post(`${base}/mark-delivered`)
      .send({ deliveryMethod: "email" });

    expect(res.status).toBe(200);
    expect(supabaseMock.callCount("insurance_claims", "update")).toBe(0);
    expect(supabaseMock.callCount("claim_appeal_letters", "update")).toBe(1);
  });
});

describe("POST .../outcome", () => {
  it("400 on an unknown outcome", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`${base}/outcome`)
      .send({ outcome: "maybe" });
    expect(res.status).toBe(400);
  });

  it("records outcome + responded_at", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null });

    const res = await request(makeApp())
      .post(`${base}/outcome`)
      .send({ outcome: "overturned", respondedAt: "2026-06-15" });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("overturned");
    const upd = supabaseMock.writePayloads(
      "claim_appeal_letters",
      "update",
    )[0] as Record<string, unknown> | undefined;
    expect(upd?.outcome).toBe("overturned");
    expect(upd?.responded_at).toBeTruthy();
  });
});
