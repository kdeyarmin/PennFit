// Tests for POST /shop/fitter-complete and GET /shop/fitter-leads/unsubscribe.
//
// Coverage split:
//
//   Constants
//     * TOUCHPOINT_OFFSETS_MS — length, T1/T6 boundary values
//     * TOTAL_TOUCHPOINTS — equals 6
//
//   signUnsubscribeToken / verifyUnsubscribeToken (round-trip via sign)
//     * round-trip: sign → verify returns { valid: true, leadId }
//     * expired token yields { valid: false, reason: 'expired' }
//     * tampered signature yields { valid: false, reason: 'bad_signature' }
//     * malformed token (missing '.') yields { valid: false, reason: 'malformed' }
//     * token without RESUPPLY_LINK_HMAC_KEY throws on sign
//
//   POST /shop/fitter-complete
//     * valid body → 200 { ok: true, enrolled: true } when lead is consent-stage + opted-in
//     * valid body → 200 { ok: true, enrolled: false } when no lead row found
//     * valid body → 200 { ok: true, enrolled: false } when lead is already campaign_active
//     * valid body → 200 { ok: true, enrolled: false } when lead not marketing-opted-in
//     * invalid body (bad email) → 400 invalid_body
//     * invalid body (bad mask type) → 400 invalid_body
//     * rate-limit after RATE_MAX submissions from the same IP → 429
//
//   GET /shop/fitter-leads/unsubscribe
//     * valid token → 200 HTML "You're unsubscribed."
//     * missing token → 400 HTML "Link no longer valid."
//     * bad signature → 400 HTML "Link no longer valid."
//     * DB error → 500 HTML "Something went wrong."

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import fitterCompleteRouter, {
  TOUCHPOINT_OFFSETS_MS,
  TOTAL_TOUCHPOINTS,
  signUnsubscribeToken,
  _resetFitterCompleteRateBucketForTests,
} from "./fitter-complete";

// ─── env setup ────────────────────────────────────────────────────
// signUnsubscribeToken needs RESUPPLY_LINK_HMAC_KEY at import time
// via getLinkHmacKey(). We set it once for the whole suite.
const TEST_HMAC_KEY = "test-fitter-complete-hmac-key-for-vitest";
let origHmacKey: string | undefined;
beforeAll(() => {
  origHmacKey = process.env.RESUPPLY_LINK_HMAC_KEY;
  process.env.RESUPPLY_LINK_HMAC_KEY = TEST_HMAC_KEY;
});
afterAll(() => {
  if (origHmacKey === undefined) {
    delete process.env.RESUPPLY_LINK_HMAC_KEY;
  } else {
    process.env.RESUPPLY_LINK_HMAC_KEY = origHmacKey;
  }
});

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", fitterCompleteRouter);
  return app;
}

const VALID_BODY = {
  email: "alice@example.com",
  recommendedMaskId: "mask-airfit-p30i",
  recommendedMaskName: "ResMed AirFit P30i",
  recommendedMaskType: "nasalPillow",
};

const SAMPLE_LEAD_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const LEAD_CONSENT = {
  id: SAMPLE_LEAD_ID,
  journey_stage: "consent",
  marketing_opt_in: true,
  completed_at: null,
};

beforeEach(() => {
  supabaseMock.reset();
  _resetFitterCompleteRateBucketForTests();
});

// ─────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────

describe("TOUCHPOINT_OFFSETS_MS", () => {
  it("has exactly 6 entries", () => {
    expect(TOUCHPOINT_OFFSETS_MS).toHaveLength(6);
  });

  it("T1 offset is 24 hours (86 400 000 ms)", () => {
    expect(TOUCHPOINT_OFFSETS_MS[0]).toBe(1 * 86_400_000);
  });

  it("T6 offset is 60 days (5 184 000 000 ms)", () => {
    expect(TOUCHPOINT_OFFSETS_MS[5]).toBe(60 * 86_400_000);
  });

  it("offsets are strictly increasing", () => {
    for (let i = 1; i < TOUCHPOINT_OFFSETS_MS.length; i++) {
      expect(TOUCHPOINT_OFFSETS_MS[i]).toBeGreaterThan(
        TOUCHPOINT_OFFSETS_MS[i - 1],
      );
    }
  });
});

describe("TOTAL_TOUCHPOINTS", () => {
  it("equals 6", () => {
    expect(TOTAL_TOUCHPOINTS).toBe(6);
  });

  it("matches TOUCHPOINT_OFFSETS_MS.length", () => {
    expect(TOTAL_TOUCHPOINTS).toBe(TOUCHPOINT_OFFSETS_MS.length);
  });
});

// ─────────────────────────────────────────────────────────────────
// signUnsubscribeToken / verifyUnsubscribeToken
// ─────────────────────────────────────────────────────────────────

describe("signUnsubscribeToken", () => {
  it("throws when RESUPPLY_LINK_HMAC_KEY is not set", () => {
    const orig = process.env.RESUPPLY_LINK_HMAC_KEY;
    try {
      delete process.env.RESUPPLY_LINK_HMAC_KEY;
      expect(() => signUnsubscribeToken("any-id")).toThrow(
        "RESUPPLY_LINK_HMAC_KEY",
      );
    } finally {
      process.env.RESUPPLY_LINK_HMAC_KEY = orig ?? TEST_HMAC_KEY;
    }
  });

  it("returns a string containing exactly one '.'", () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    expect(token.split(".")).toHaveLength(2);
  });

  it("is deterministic for the same leadId and time", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const t1 = signUnsubscribeToken(SAMPLE_LEAD_ID, now);
    const t2 = signUnsubscribeToken(SAMPLE_LEAD_ID, now);
    expect(t1).toBe(t2);
  });

  it("produces different tokens for different lead IDs", () => {
    const now = new Date("2025-06-01T00:00:00Z");
    const t1 = signUnsubscribeToken("lead-id-one", now);
    const t2 = signUnsubscribeToken("lead-id-two", now);
    expect(t1).not.toBe(t2);
  });
});

// verifyUnsubscribeToken is not exported, so we exercise it via the
// GET route. For the pure-function tests we use the exported sign
// function and then inspect route responses.

describe("signUnsubscribeToken → route verify round-trip", () => {
  it("a freshly signed token produces a 200 'You're unsubscribed.' page", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    // DB update returns success (no error)
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
  });

  it("a token signed with a future 'now' that is past TTL returns 400 expired/invalid", async () => {
    // Sign with a date that places expiry < Date.now() (i.e., NOW was 7 months ago)
    const pastDate = new Date(
      Date.now() - 181 * 86_400_000, // 181 days ago → 6-month TTL is already past
    );
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID, pastDate);

    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );
    // Expired tokens are treated as invalid → 400
    expect(res.status).toBe(400);
    expect(res.text).toContain("Link no longer valid");
  });

  it("a tampered signature returns 400 'Link no longer valid'", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    // Flip a character in the signature (after the '.')
    const [payload, sig] = token.split(".");
    const badSig = sig!.slice(0, -1) + (sig!.slice(-1) === "a" ? "b" : "a");
    const badToken = `${payload}.${badSig}`;

    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(badToken)}`,
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain("Link no longer valid");
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /shop/fitter-complete
// ─────────────────────────────────────────────────────────────────

describe("POST /shop/fitter-complete", () => {
  it("returns 200 { ok: true, enrolled: true } for a consent-stage opted-in lead", async () => {
    // Lookup returns a lead; update succeeds
    stageSupabaseResponse("fitter_leads", "select", {
      data: [LEAD_CONSENT],
    });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enrolled: true });
  });

  it("writes the recommended mask fields and campaign_active stage on enrollment", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [LEAD_CONSENT],
    });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    const [updatePayload] = supabaseMock.writePayloads("fitter_leads", "update") as Array<Record<string, unknown>>;
    expect(updatePayload).toBeDefined();
    expect(updatePayload.journey_stage).toBe("campaign_active");
    expect(updatePayload.recommended_mask_id).toBe(VALID_BODY.recommendedMaskId);
    expect(updatePayload.recommended_mask_name).toBe(VALID_BODY.recommendedMaskName);
    expect(updatePayload.recommended_mask_type).toBe(VALID_BODY.recommendedMaskType);
    expect(updatePayload.next_campaign_touch_at).toBeTruthy();
  });

  it("returns 200 { ok: true, enrolled: false } when no lead row exists", async () => {
    stageSupabaseResponse("fitter_leads", "select", { data: [] });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.reason).toBe("no_lead");
  });

  it("returns 200 enrolled=false when lead is already campaign_active (idempotent)", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [{ ...LEAD_CONSENT, journey_stage: "campaign_active" }],
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.reason).toBe("campaign_active");
  });

  it("returns 200 enrolled=false when lead is in a terminal 'converted' stage", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [{ ...LEAD_CONSENT, journey_stage: "converted" }],
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.reason).toBe("converted");
  });

  it("returns 200 enrolled=false when lead is in 'unsubscribed' stage", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [{ ...LEAD_CONSENT, journey_stage: "unsubscribed" }],
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.reason).toBe("unsubscribed");
  });

  it("stamps journey_stage='completed' (not campaign_active) when lead has no marketing_opt_in", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      data: [{ ...LEAD_CONSENT, marketing_opt_in: false }],
    });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.reason).toBe("no_marketing_opt_in");

    const [updatePayload] = supabaseMock.writePayloads("fitter_leads", "update") as Array<Record<string, unknown>>;
    expect(updatePayload?.journey_stage).toBe("completed");
  });

  it("returns 400 with error='invalid_body' for a missing email field", async () => {
    const { email: _omit, ...noEmail } = VALID_BODY;
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(noEmail);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 with error='invalid_body' for an unrecognised mask type", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send({ ...VALID_BODY, recommendedMaskType: "unknown_type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 with error='invalid_body' for an invalid email", async () => {
    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send({ ...VALID_BODY, email: "not-an-email" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 200 ok:true even when the DB lookup throws (best-effort)", async () => {
    stageSupabaseResponse("fitter_leads", "select", {
      error: { message: "connection lost" },
    });

    const res = await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY);

    // Best-effort: never 5xx the patient
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.enrolled).toBe(false);
  });

  it("rate-limits the same IP after 10 requests in the window", async () => {
    const app = makeApp();
    // Stage enough lookup responses so the first 10 requests succeed
    for (let i = 0; i < 10; i++) {
      stageSupabaseResponse("fitter_leads", "select", { data: [] });
    }

    for (let i = 0; i < 10; i++) {
      const ok = await request(app)
        .post("/resupply-api/shop/fitter-complete")
        .send(VALID_BODY)
        .set("X-Forwarded-For", "10.0.0.1");
      expect(ok.status).toBe(200);
    }

    const limited = await request(app)
      .post("/resupply-api/shop/fitter-complete")
      .send(VALID_BODY)
      .set("X-Forwarded-For", "10.0.0.1");
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("rate_limited");
  });

  it("normalises the email to lowercase before the DB lookup", async () => {
    stageSupabaseResponse("fitter_leads", "select", { data: [] });

    await request(makeApp())
      .post("/resupply-api/shop/fitter-complete")
      .send({ ...VALID_BODY, email: "  Alice@EXAMPLE.COM  " });

    const filterCalls = supabaseMock.filterCalls("fitter_leads", "select");
    const eqCall = filterCalls.find(
      (c) => c.verb === "eq" && c.args[0] === "email",
    );
    expect(eqCall?.args[1]).toBe("alice@example.com");
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /shop/fitter-leads/unsubscribe
// ─────────────────────────────────────────────────────────────────

describe("GET /shop/fitter-leads/unsubscribe", () => {
  it("returns 400 HTML 'Link no longer valid.' when no token is supplied", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/shop/fitter-leads/unsubscribe",
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain("Link no longer valid");
  });

  it("returns 400 HTML when the token is structurally malformed (no '.')", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/shop/fitter-leads/unsubscribe?t=nodotatall",
    );
    expect(res.status).toBe(400);
    expect(res.text).toContain("Link no longer valid");
  });

  it("returns 200 HTML 'You're unsubscribed.' on a valid token and successful DB update", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
  });

  it("updates the correct fitter_leads row (eq filter on id)", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );

    const filterCalls = supabaseMock.filterCalls("fitter_leads", "update");
    const eqCall = filterCalls.find(
      (c) => c.verb === "eq" && c.args[0] === "id",
    );
    expect(eqCall?.args[1]).toBe(SAMPLE_LEAD_ID);
  });

  it("sets journey_stage='unsubscribed' and clears next_campaign_touch_at on the DB update", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );

    const [payload] = supabaseMock.writePayloads("fitter_leads", "update") as Array<Record<string, unknown>>;
    expect(payload?.journey_stage).toBe("unsubscribed");
    expect(payload?.next_campaign_touch_at).toBeNull();
  });

  it("returns 500 HTML 'Something went wrong.' when the DB update fails", async () => {
    const token = signUnsubscribeToken(SAMPLE_LEAD_ID);
    stageSupabaseResponse("fitter_leads", "update", {
      error: { message: "DB down" },
    });

    const res = await request(makeApp()).get(
      `/resupply-api/shop/fitter-leads/unsubscribe?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(500);
    expect(res.text).toContain("Something went wrong");
  });

  it("response Content-Type is text/html for all outcomes", async () => {
    const res = await request(makeApp()).get(
      "/resupply-api/shop/fitter-leads/unsubscribe",
    );
    expect(res.headers["content-type"]).toContain("text/html");
  });
});