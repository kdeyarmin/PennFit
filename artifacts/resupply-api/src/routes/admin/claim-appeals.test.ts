// Tests for the appeal-letter fax route added in this PR:
//   POST /admin/patients/:id/insurance-claims/:claimId/appeal-letter/:letterId/fax

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
vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () =>
    Buffer.from("test-hmac-key-32bytes-padded-xxxx", "utf8"),
}));

// Control fax configuration + the Telnyx client without env/network.
const faxConfigured = vi.hoisted(() => ({ current: true }));
const sendFax = vi.hoisted(() => ({
  current: vi.fn(async () => ({ id: "tx-123", status: "queued" })),
}));
vi.mock("./physician-fax-outreach", () => ({
  isFaxConfigured: () => faxConfigured.current,
  getFaxPublicBaseUrl: () => "https://app.example.com",
  default: {},
}));
const { FakeTelnyxApiError } = vi.hoisted(() => {
  class FakeTelnyxApiError extends Error {}
  return { FakeTelnyxApiError };
});
vi.mock("@workspace/resupply-telecom", () => ({
  createTelnyxFaxClient: () => ({ sendFax: sendFax.current }),
  TelnyxApiError: FakeTelnyxApiError,
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
const url = `/admin/patients/${PID}/insurance-claims/${CLAIM_ID}/appeal-letter/${LETTER_ID}/fax`;

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(claimAppealsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  faxConfigured.current = true;
  sendFax.current = vi.fn(async () => ({ id: "tx-123", status: "queued" }));
  process.env.TELNYX_FAX_FROM_NUMBER = "+15555550100";
  supabaseMock.reset();
});

describe("POST appeal-letter/:letterId/fax", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(401);
  });

  it("400 on a malformed fax number", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(url).send({ faxNumber: "nope" });
    expect(res.status).toBe(400);
  });

  it("404 when the letter doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(404);
  });

  it("404 when the letter belongs to a different claim", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: "99999999-9999-4999-8999-999999999999" },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(404);
  });

  it("503 when fax isn't configured", async () => {
    mockAdmin.current = ADMIN;
    faxConfigured.current = false;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("fax_not_configured");
  });

  it("dispatches the fax and marks delivery_method=fax", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(200);
    expect(res.body.vendorRef).toBe("tx-123");
    expect(sendFax.current).toHaveBeenCalledOnce();
    // delivery_method=fax was written.
    const writes = supabaseMock.writePayloads("claim_appeal_letters", "update");
    expect(writes[0]).toMatchObject({ delivery_method: "fax" });
  });

  it("transitions a denied claim to appealed + resolves its denial analysis on a successful fax", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID, denial_analysis_id: "da-1" },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID, status: "denied" },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null });
    // The conditional update returns the transitioned row (so the route emits
    // the history event + webhook).
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_ID }],
    });
    stageSupabaseResponse("insurance_claim_events", "insert", {
      data: { id: "evt-1" },
    });
    stageSupabaseResponse("claim_denial_analyses", "update", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });

    expect(res.status).toBe(200);
    // Claim moved denied -> appealed (drops off the denials worklist).
    expect(
      supabaseMock.writePayloads("insurance_claims", "update")[0],
    ).toMatchObject({ status: "appealed" });
    // A replayable history event is written for the transition (mirrors the
    // canonical PATCH side effects).
    expect(
      supabaseMock.writePayloads("insurance_claim_events", "insert")[0],
    ).toMatchObject({ event_type: "appealed", claim_id: CLAIM_ID });
    // The linked denial analysis is marked resolved.
    expect(
      supabaseMock.writePayloads("claim_denial_analyses", "update")[0],
    ).toMatchObject({ review_status: "accepted_appealed" });
  });

  it("does NOT transition a claim that is not denied", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID, denial_analysis_id: "da-1" },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID, status: "appealed" },
    });
    stageSupabaseResponse("claim_appeal_letters", "update", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });

    expect(res.status).toBe(200);
    // Already appealed → no further status write, no analysis write.
    expect(supabaseMock.callCount("insurance_claims", "update")).toBe(0);
    expect(supabaseMock.callCount("claim_denial_analyses", "update")).toBe(0);
  });

  it("502 when Telnyx dispatch throws", async () => {
    mockAdmin.current = ADMIN;
    sendFax.current = vi.fn(async () => {
      throw new FakeTelnyxApiError("boom");
    });
    stageSupabaseResponse("claim_appeal_letters", "select", {
      data: { id: LETTER_ID, claim_id: CLAIM_ID },
    });
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, patient_id: PID },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ faxNumber: "+18005551212" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("fax_dispatch_failed");
  });
});

describe("GET insurance-claims/:claimId/denial-sketch", () => {
  const sketchUrl = `/admin/patients/${PID}/insurance-claims/${CLAIM_ID}/denial-sketch`;
  const DA_ID = "44444444-4444-4444-8444-444444444444";

  it("500 tenant_context_missing when orgId is absent", async () => {
    // orgId: null tells the requireAdmin mock to attach no req.orgId, so the
    // route hits its fail-closed missing-tenant guard.
    mockAdmin.current = { ...ADMIN, orgId: null };
    const res = await request(makeApp()).get(sketchUrl);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
  });

  it("404 claim_not_found when the claim/patient pair has no row", async () => {
    mockAdmin.current = ADMIN;
    // insurance_claims is queried first; a null row → 404 (claim_denial_analyses
    // is never reached).
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp()).get(sketchUrl);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("claim_not_found");
    expect(supabaseMock.callCount("claim_denial_analyses", "select")).toBe(0);
  });

  it("200 with all-null payload when the claim has no denial analysis", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, latest_denial_analysis_id: null },
    });
    const res = await request(makeApp()).get(sketchUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      denialAnalysisId: null,
      recommendation: null,
      sketch: null,
    });
    // No second read when there's no analysis pointer.
    expect(supabaseMock.callCount("claim_denial_analyses", "select")).toBe(0);
  });

  it("200 returns the recommendation + appealLetterSketch from the latest analysis", async () => {
    mockAdmin.current = ADMIN;
    // Staging order mirrors the route: insurance_claims first, then
    // claim_denial_analyses.
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM_ID, latest_denial_analysis_id: DA_ID },
    });
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: {
        id: DA_ID,
        recommendation: "appeal",
        analysis_json: { appealLetterSketch: "Dear payer, please reconsider…" },
      },
    });
    const res = await request(makeApp()).get(sketchUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      denialAnalysisId: DA_ID,
      recommendation: "appeal",
      sketch: "Dear payer, please reconsider…",
    });
  });
});
