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

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

// The route resolves its tenant from the token's invite via this helper
// (covered by signed-link-org.test). Stub it to the seed org so these
// tests exercise the route itself, not the cross-tenant lookup.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: vi.fn(async () => SEED_ORG),
}));

// Resolve reports the tenant's v2 fit-profile flag; default everything off.
const featureFlags = vi.hoisted(() => ({ enabled: new Set<string>() }));
vi.mock("../../lib/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async (key: string) => featureFlags.enabled.has(key)),
}));

import fitterInviteRouter from "./fitter-invite";
import { signFitterInviteToken } from "../../lib/fitter-invite-token";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org";

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
  featureFlags.enabled = new Set();
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
      // The capture-shaping flags ride on resolve (the one call that knows
      // the tenant before /capture and /questionnaire render); both off by
      // default.
      fitProfileV2: false,
      multiframeCapture: false,
    });
    // The tenant was resolved from the token's invite, not a fixed seed.
    expect(vi.mocked(resolveOrgIdForSignedRecord)).toHaveBeenCalledWith(
      "fitter_invites",
      INVITE_ID,
    );
  });

  it("carries fitProfileV2:true when the tenant enables the flag", async () => {
    featureFlags.enabled = new Set(["fitter.fit_profile_v2"]);
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "opened",
        recipient_email: "p@example.com",
        recipient_name: "Pat Q",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-invite/resolve?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.fitProfileV2).toBe(true);
    expect(res.body.multiframeCapture).toBe(false);
  });

  it("carries multiframeCapture:true when the tenant enables the flag", async () => {
    featureFlags.enabled = new Set(["fitter.multiframe_capture"]);
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "opened",
        recipient_email: "p@example.com",
        recipient_name: "Pat Q",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-invite/resolve?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.multiframeCapture).toBe(true);
    expect(res.body.fitProfileV2).toBe(false);
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
    // Terminal state stays sticky — a re-submit is a DATA-ONLY update
    // that never touches the lifecycle columns at all (writing them from
    // a stale read is how a concurrent attach could be regressed), and
    // the true first-open is preserved the same way.
    expect(upd.status).toBeUndefined();
    expect(upd.completed_at).toBeUndefined();
    expect(upd.opened_at).toBeUndefined();
    // The fitting data itself IS refreshed.
    expect(upd.recommended_mask_id).toBeDefined();
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

  it("409s when the invite row has expired, even under a still-valid token", async () => {
    // Staff resend rewrites `expires_at` while previously-minted tokens
    // stay valid to their own embedded expiry — so the row's expiry must
    // be enforced here exactly as /resolve and /api/fit/assess do, or a
    // stale tab keeps writing measurements onto a dead invite.
    const token = signFitterInviteToken(INVITE_ID);
    stageSupabaseResponse("fitter_invites", "select", {
      data: {
        id: INVITE_ID,
        status: "opened",
        patient_id: null,
        recipient_email: "p@example.com",
        recipient_phone_e164: null,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("expired");
    expect(getSupabaseWritePayloads("fitter_invites", "update")).toHaveLength(
      0,
    );
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

  it("400s on measurements outside the adult∪pediatric plausibility window", async () => {
    // Same posture as /api/recommend and /api/fit/assess: this route
    // stores what it accepts, so non-face numerics (a bad iris
    // calibration, a hand-rolled request) are rejected, not recorded.
    const token = signFitterInviteToken(INVITE_ID);
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({
        t: token,
        measurements: { ...measurements, noseWidth: 500 },
        answers,
        recommendation,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseWritePayloads("fitter_invites", "update")).toHaveLength(
      0,
    );
  });

  it("400s when the body smuggles encoded media, even under a key the schema would strip", async () => {
    // "No images in the backend" is a hard rule. The media guard runs on
    // the RAW body, so a data-URL hidden under an unknown key — which
    // plain z.object would silently strip — still rejects loudly.
    const token = signFitterInviteToken(INVITE_ID);
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({
        t: token,
        measurements: {
          ...measurements,
          selfie: "data:image/png;base64,AAAA",
        },
        answers,
        recommendation,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseWritePayloads("fitter_invites", "update")).toHaveLength(
      0,
    );
  });

  it("400s on answers that are not bounded scalars", async () => {
    // The answers record is scalars-only (the v1 questionnaire shape) —
    // a nested object is exactly where a blob would hide.
    const token = signFitterInviteToken(INVITE_ID);
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({
        t: token,
        measurements,
        answers: { mouthBreather: { nested: "object" } },
        recommendation,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("strips unknown keys instead of storing them", async () => {
    // Unknown keys must neither 400 the transmission (it is
    // fire-and-forget on the client) nor reach the jsonb columns.
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
      .send({
        t: token,
        measurements: { ...measurements, extraField: "should not persist" },
        answers,
        recommendation: {
          ...recommendation,
          top: [{ ...recommendation.top[0]!, surprise: "extra" }],
        },
      });
    expect(res.status).toBe(200);
    const upd = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd.measurements).toEqual(measurements);
    expect(
      (upd.recommendations as Array<Record<string, unknown>>)[0],
    ).not.toHaveProperty("surprise");
  });

  // The regression this whole change exists for. The clinical engine
  // declines to name a mask on a contraindicated / out-of-validated-range
  // / everything-excluded fitting, so /results has no `topPick` — and
  // while `recommendation` was REQUIRED here, it transmitted nothing at
  // all. The invite stayed at "opened" with no measurements and no
  // completion time, and the fittings that most needed a human were the
  // only ones staff never saw.
  it("records a completed fitting that named no mask", async () => {
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
    stageSupabaseResponse("fitter_invites", "update", {
      data: [{ id: INVITE_ID }],
    });
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, matched: false });
    const upd = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    )[0] as Record<string, unknown>;
    // The fitting IS recorded — this is a completion, not a dropped call.
    expect(upd.status).toBe("completed");
    expect(upd.completed_at).toEqual(expect.any(String));
    expect(upd.measurements).toEqual(measurements);
    // …and no mask is invented to fill the columns.
    expect(upd.recommended_mask_id).toBeNull();
    expect(upd.recommended_mask_name).toBeNull();
    expect(upd.recommended_mask_type).toBeNull();
  });

  it("does not blank a stored ranked list when it has none to send", async () => {
    // Both writers fire for a clinical fitting: /api/fit/assess records
    // the alternatives it considered even when it names no primary, and
    // the page's own transmission then arrives with nothing to say about
    // them. Writing an empty list here would erase the one already
    // stored — the only place staff can see what was ruled out.
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
    stageSupabaseResponse("fitter_invites", "update", {
      data: [{ id: INVITE_ID }],
    });
    await request(makeApp())
      .post("/resupply-api/shop/fitter-invite/complete")
      .send({ t: token, measurements, answers, recommendation: null });

    const upd = getSupabaseWritePayloads(
      "fitter_invites",
      "update",
    )[0] as Record<string, unknown>;
    expect(upd).not.toHaveProperty("recommendations");
  });
});
