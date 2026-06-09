// Route tests for the public AI mask-fitter invite endpoints.
//
// Coverage:
//   GET /shop/fitter-invite/resolve
//     * valid token → { valid:true, email, name } + flips sent→opened
//     * bad/expired/revoked token → { valid:false, reason }
//   POST /shop/fitter-invite/complete
//     * valid body → stores results, auto-attaches on unique email match
//     * no patient match → matched:false, patient_id left null
//     * invalid token → 401
//     * invalid body → 400

import { describe, it, expect, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import fitterInviteRouter from "./fitter-invite";
import { signFitterInviteToken } from "../../lib/fitter-invite-token";

const INVITE_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", fitterInviteRouter);
  return app;
}

const measurements = {
  noseWidth: 32.1,
  noseHeight: 48.2,
  noseToChin: 60.5,
  mouthWidth: 45.0,
  faceWidthAtCheekbones: 130.4,
  calibrationMethod: "iris",
};
const answers = { mouthBreather: true, priorMaskExperience: "none" };
const recommendation = {
  maskId: "mask-1",
  name: "AirFit P10",
  type: "nasalPillow" as const,
  top: [{ maskId: "mask-1", name: "AirFit P10", type: "nasalPillow" as const }],
};

beforeEach(() => {
  supabaseMock.reset();
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
});

describe("GET /shop/fitter-invite/resolve", () => {
  it("resolves a valid token and flips sent→opened", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "sent",
        recipient_email: "p@example.com",
        recipient_name: "Pat Q",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-invite/resolve?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: true,
      email: "p@example.com",
      name: "Pat Q",
    });
  });

  it("returns valid:false for a bad signature", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/shop/fitter-invite/resolve?t=bogus.token",
    );
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it("fails soft (200, valid:false) when the lookup errors", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      error: { message: "db down" },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-invite/resolve?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: "error" });
  });

  it("returns valid:false reason:revoked", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "revoked",
        recipient_email: "p@example.com",
        recipient_name: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-invite/resolve?t=${encodeURIComponent(token)}`,
    );
    expect(res.body).toEqual({ valid: false, reason: "revoked" });
  });
});

describe("POST /shop/fitter-invite/complete", () => {
  it("stores results and auto-attaches on a unique email match", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "opened",
        patient_id: null,
        recipient_email: "p@example.com",
        recipient_phone_e164: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    // findUniquePatient by email → exactly one row.
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }],
    });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: true });

    const writes = getSupabaseWritePayloads("fitter_invites", "update");
    const upd = writes[0] as Record<string, unknown>;
    expect(upd.status).toBe("completed");
    expect(upd.patient_id).toBe(PATIENT_ID);
    expect(upd.auto_matched).toBe(true);
    expect(upd.recommended_mask_id).toBe("mask-1");
  });

  it("leaves patient_id null when no patient matches", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "opened",
        patient_id: null,
        recipient_email: "nomatch@example.com",
        recipient_phone_e164: null,
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: false });
    const upd = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.patient_id).toBeUndefined();
  });

  it("keeps an already-attached fitting attached on re-submit", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "attached",
        patient_id: PATIENT_ID,
        recipient_email: "p@example.com",
        recipient_phone_e164: null,
        opened_at: "2026-01-01T00:00:00.000Z",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    stageSupabaseResponse("fitter_invites", "update", { data: null });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation });
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    )[0] as Record<string, unknown>;
    // Terminal state stays sticky; the true first-open is preserved.
    expect(upd.status).toBe("attached");
    expect(upd.opened_at).toBeUndefined();
  });

  it("fails soft (200) when the invite lookup errors", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      error: { message: "db down" },
    });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: false });
  });

  it("401s on an invalid token", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: "bad.token", measurements, answers, recommendation });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("400s on an invalid body", async () => {
    const token = signFitterInviteToken(INVITE_ID);
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({
        t: token,
        measurements: { noseWidth: 1 },
        answers,
        recommendation,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });
});
