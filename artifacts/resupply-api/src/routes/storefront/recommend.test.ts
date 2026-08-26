// Route tests for routes/storefront/recommend.ts
//
// Two concerns:
//  1. The invitation-only gate. The virtual mask fitter is reachable
//     only through a signed invite link a DME company sends a patient;
//     the recommendation endpoint requires a valid, unexpired invite
//     token in the `x-fitter-invite-token` header. A missing, malformed,
//     mis-signed, or expired token is rejected with 403.
//  2. The server-side plausibility guard. The /recommend endpoint is
//     stateless; the on-device PLAUSIBILITY_BOUNDS check in the SPA
//     (measure-flow.ts) is not a security boundary, so the route must
//     reject numerically out-of-range measurements itself. These tests
//     pin that a direct (invited) caller can't feed garbage measurements
//     past Zod's shape check.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import recommendRouter from "./recommend";
import {
  signFitterInviteToken,
  FITTER_INVITE_TTL_MS,
} from "../../lib/fitter-invite-token";
import {
  ADULT_PLAUSIBILITY_BOUNDS,
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  PLAUSIBILITY_FIELDS,
} from "../../lib/fitting/index";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(recommendRouter);
  return app;
}

// Set a deterministic HMAC key so signFitterInviteToken /
// verifyFitterInviteToken agree within the test process. Must run
// before any token is minted. Capture and restore the prior value so
// this file can't leak the test key into other suites.
let savedLinkHmacKey: string | undefined;
beforeAll(() => {
  savedLinkHmacKey = process.env.RESUPPLY_LINK_HMAC_KEY;
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
});
afterAll(() => {
  if (savedLinkHmacKey === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
  else process.env.RESUPPLY_LINK_HMAC_KEY = savedLinkHmacKey;
});

const INVITE_ID = "11111111-1111-1111-1111-111111111111";

/** A valid, unexpired invite token for the happy-path requests. */
function validToken(): string {
  return signFitterInviteToken(INVITE_ID);
}

/**
 * POST /recommend with a valid invite token attached. Centralises the
 * header so the plausibility-guard cases below read as before.
 */
function postRecommend(body: Record<string, unknown>) {
  // Tests that intentionally omit population must pass `population: undefined`
  // via a body that has the key; otherwise default adult so plausibility
  // cases stay focused on measurement bounds.
  const payload =
    Object.prototype.hasOwnProperty.call(body, "population")
      ? body
      : { ...body, population: "adult" };
  // Drop the key when explicitly undefined so Zod sees "omitted".
  if (payload.population === undefined) {
    const { population: _omit, ...rest } = payload;
    return request(makeApp())
      .post("/recommend")
      .set("x-fitter-invite-token", validToken())
      .send(rest);
  }
  return request(makeApp())
    .post("/recommend")
    .set("x-fitter-invite-token", validToken())
    .send(payload);
}

// The canonical face — MediaPipe's metric reference mesh, as this
// pipeline's landmark pairs measure it (see
// lib/fitting/plausibility-windows.test.ts). A fixture that claims to be
// a normal adult face should be one; the previous hand-picked numbers
// carried a 40 mm noseHeight, which is the ~50 mm textbook
// nasion→subnasale span, not the ~29 mm bridge→tip span this route
// actually receives.
const VALID_MEASUREMENTS = {
  noseWidth: 35.7,
  noseHeight: 29.4,
  noseToChin: 89.4,
  mouthWidth: 49.1,
  faceWidthAtCheekbones: 153.3,
  calibrationMethod: "iris" as const,
};

const VALID_ANSWERS = {
  mouthBreather: false,
  claustrophobic: false,
  sideOrStomachSleeper: false,
  heavyFacialHair: false,
  wearsGlasses: false,
  frequentCongestion: false,
  priorMaskExperience: "none" as const,
  mobilityLimitations: false,
  sensitiveSkin: false,
  siliconeSensitivity: false,
  cpapPressureSetting: "medium" as const,
};

describe("POST /recommend — invitation-only gate", () => {
  it("rejects a request with NO invite token (403)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS, population: "adult" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invitation only/i);
  });

  it("rejects a request with a malformed token (403)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .set("x-fitter-invite-token", "not-a-real-token")
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS, population: "adult" });
    expect(res.status).toBe(403);
  });

  it("rejects a request whose token has a tampered signature (403)", async () => {
    const token = validToken();
    // Flip the last character of the signature segment.
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const res = await request(makeApp())
      .post("/recommend")
      .set("x-fitter-invite-token", tampered)
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS, population: "adult" });
    expect(res.status).toBe(403);
  });

  it("rejects a request with an expired token (403)", async () => {
    // Mint a token whose expiry is already in the past.
    const expired = signFitterInviteToken(
      INVITE_ID,
      new Date(Date.now() - FITTER_INVITE_TTL_MS - 60_000),
    );
    const res = await request(makeApp())
      .post("/recommend")
      .set("x-fitter-invite-token", expired)
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS, population: "adult" });
    expect(res.status).toBe(403);
  });

  it("allows a request with a valid, unexpired token (200)", async () => {
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: "adult",
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.topRecommendations)).toBe(true);
  });
});

describe("POST /recommend — plausibility guard", () => {
  it("returns 200 with ranked recommendations for in-range measurements", async () => {
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: "adult",
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.topRecommendations)).toBe(true);
    expect(res.body.topRecommendations.length).toBeGreaterThan(0);
  });

  it("accepts the exact min/max boundary values", async () => {
    // Bounds are inclusive on both edges.
    for (const edge of [0, 1] as const) {
      const res = await postRecommend({
        measurements: {
          ...Object.fromEntries(
            PLAUSIBILITY_FIELDS.map((f) => [
              f,
              ADULT_PLAUSIBILITY_BOUNDS[f][edge],
            ]),
          ),
          calibrationMethod: "iris",
        },
        answers: VALID_ANSWERS,
      });
      expect(res.status, edge === 0 ? "all-min" : "all-max").toBe(200);
    }
  });

  it("rejects an out-of-range (too small) noseWidth with 400", async () => {
    const res = await postRecommend({
      measurements: { ...VALID_MEASUREMENTS, noseWidth: 5 },
      answers: VALID_ANSWERS,
    });
    expect(res.status).toBe(400);
    // The SPA shows this string verbatim as the failure message, so it
    // must tell the patient what to DO, not just that input was invalid.
    expect(res.body.error).toMatch(/outside the range|fit you in person/i);
    expect(res.body.details.join(" ")).toContain("noseWidth");
  });

  it("rejects an absurdly large faceWidthAtCheekbones with 400", async () => {
    const res = await postRecommend({
      measurements: { ...VALID_MEASUREMENTS, faceWidthAtCheekbones: 5000 },
      answers: VALID_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("faceWidthAtCheekbones");
  });

  it("rejects a negative measurement with 400", async () => {
    const res = await postRecommend({
      measurements: { ...VALID_MEASUREMENTS, noseToChin: -10 },
      answers: VALID_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseToChin");
  });

  // ── Per-field boundary coverage ─────────────────────────────────────────
  // Driven off the window itself rather than transcribed numbers: these
  // used to name their bounds in the test title ("accepts noseWidth at
  // its upper bound (60 mm)"), so recalibrating the window meant editing
  // ten titles, and a stale one asserted the OLD bound was still
  // enforced. The claim being made is "the route enforces exactly this
  // window on every field, inclusive", which is what this says.

  it.each(PLAUSIBILITY_FIELDS)(
    "accepts %s at both of its bounds",
    async (field) => {
      for (const value of ADULT_PLAUSIBILITY_BOUNDS[field]) {
        const res = await postRecommend({
          measurements: { ...VALID_MEASUREMENTS, [field]: value },
          answers: VALID_ANSWERS,
        });
        expect(res.status, `${field}=${value}`).toBe(200);
      }
    },
  );

  it.each(PLAUSIBILITY_FIELDS)(
    "rejects %s just outside either bound with 400",
    async (field) => {
      const [min, max] = ADULT_PLAUSIBILITY_BOUNDS[field];
      for (const value of [min - 0.1, max + 0.1]) {
        const res = await postRecommend({
          measurements: { ...VALID_MEASUREMENTS, [field]: value },
          answers: VALID_ANSWERS,
        });
        expect(res.status, `${field}=${value}`).toBe(400);
        expect(res.body.details.join(" ")).toContain(field);
      }
    },
  );

  it("error details include the mm unit and the numeric bounds", async () => {
    // Verify the error message format so callers can surface it to users.
    const res = await postRecommend({
      measurements: { ...VALID_MEASUREMENTS, noseWidth: 5 },
      answers: VALID_ANSWERS,
    });
    expect(res.status).toBe(400);
    const detail = res.body.details[0] as string;
    expect(detail).toContain("measurements.noseWidth");
    expect(detail).toContain("mm");
    expect(detail).toContain(String(ADULT_PLAUSIBILITY_BOUNDS.noseWidth[0]));
    expect(detail).toContain(String(ADULT_PLAUSIBILITY_BOUNDS.noseWidth[1]));
  });

  it("returns only one error entry when the first checked field is invalid (early-return behaviour)", async () => {
    // The guard short-circuits on the first violation; the response
    // details array must have exactly one entry, not one per field.
    const res = await postRecommend({
      measurements: {
        ...VALID_MEASUREMENTS,
        // noseWidth is checked first in PLAUSIBILITY_BOUNDS
        noseWidth: 5,
        noseHeight: 5,
      },
      answers: VALID_ANSWERS,
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Adult or child — the service line the fitting runs on
// ---------------------------------------------------------------------------

describe("POST /recommend — population", () => {
  it("rejects when population is omitted (never assume adult)", async () => {
    // Population is asked, never assumed — omitting used to silently size
    // children against adult bands. The SPA always sends the gate answer.
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: undefined,
    });
    expect(res.status).toBe(400);
  });

  it("ranks nothing for a pediatric session, and says so", async () => {
    // Not a failure: the catalog carries no pediatric interfaces. The
    // SPA reads the echoed population to tell this apart from an adult
    // whose measurements simply didn't rank, and refers the patient to
    // the DME instead of sending them back to the camera.
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: "pediatric",
    });
    expect(res.status).toBe(200);
    expect(res.body.population).toBe("pediatric");
    expect(res.body.topRecommendations).toEqual([]);
    expect(res.body.alternatives).toEqual([]);
  });

  it("measures a pediatric session against the PEDIATRIC window", async () => {
    // A genuinely child-sized face: every dimension sits just above the
    // pediatric FLOOR and below the adult one. (The two windows share a
    // ceiling by construction — an adolescent has adult dimensions — so
    // only the floor can tell them apart.)
    const childFace = Object.fromEntries(
      PLAUSIBILITY_FIELDS.map((f) => {
        const [pediatricMin] = PEDIATRIC_PLAUSIBILITY_BOUNDS[f];
        const [adultMin] = ADULT_PLAUSIBILITY_BOUNDS[f];
        expect(pediatricMin).toBeLessThan(adultMin);
        return [f, pediatricMin + 1];
      }),
    );
    const measurements = { ...childFace, calibrationMethod: "iris" as const };

    // As a CHILD the numbers are plausible, so the request reaches the
    // engine — which then declines on service line, and the SPA can say
    // "children are fitted in person" instead of blaming the photo.
    const asChild = await postRecommend({
      measurements,
      answers: VALID_ANSWERS,
      population: "pediatric",
    });
    expect(asChild.status).toBe(200);
    expect(asChild.body.population).toBe("pediatric");
    expect(asChild.body.topRecommendations).toEqual([]);

    // The same face claimed as an ADULT is still implausible, and still
    // rejected — widening the window is scoped to the stated service
    // line, not applied to everyone.
    const asAdult = await postRecommend({
      measurements,
      answers: VALID_ANSWERS,
      population: "adult",
    });
    expect(asAdult.status).toBe(400);
  });

  it("rejects a payload whose population is not a known service line", async () => {
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: "teenager",
    });
    expect(res.status).toBe(400);
  });
});

// ── Rate limiting ────────────────────────────────────────────────────
//
// The mask-scoring limiter used to be mounted app-level
// (`app.use("/api/recommend", …)` in app.ts). That capped the route, but
// it was invisible both to a reader of recommend.ts and to CodeQL's
// js/missing-rate-limiting query, which only recognises a limiter at the
// handler's own registration — so an authorization-performing route read
// as unlimited. It now sits on the route itself.
//
// These tests mount the ROUTER alone, exactly as the app does, so a
// regression that moved the limiter back out would fail here.

describe("rate limiting", () => {
  it("applies the shared mask-scoring limiter at the route", async () => {
    const res = await postRecommend({
      measurements: VALID_MEASUREMENTS,
      answers: VALID_ANSWERS,
      population: "adult",
    });
    // draft-7 standard headers — present only if the limiter actually ran.
    expect(res.headers["ratelimit"]).toBeDefined();
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });

  it("runs the limiter BEFORE the invite gate, so an unauthorized flood is capped too", async () => {
    // The limiter has to sit ahead of the authorization check or a
    // caller with no token at all could hammer the route for free.
    const res = await request(makeApp())
      .post("/recommend")
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS, population: "adult" });
    expect(res.status).toBe(403);
    expect(res.headers["ratelimit"]).toBeDefined();
  });
});
