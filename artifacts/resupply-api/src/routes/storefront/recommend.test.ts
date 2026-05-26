// Route tests for routes/storefront/recommend.ts
//
// Focus: the server-side plausibility guard. The /recommend endpoint is
// stateless and public; the on-device PLAUSIBILITY_BOUNDS check in the
// SPA (measure-flow.ts) is not a security boundary, so the route must
// reject numerically out-of-range measurements itself. These tests pin
// that a direct caller can't feed garbage measurements past Zod's shape
// check.

import { describe, it, expect } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import recommendRouter from "./recommend";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(recommendRouter);
  return app;
}

const VALID_MEASUREMENTS = {
  noseWidth: 28,
  noseHeight: 40,
  noseToChin: 55,
  mouthWidth: 45,
  faceWidthAtCheekbones: 135,
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

describe("POST /recommend — plausibility guard", () => {
  it("returns 200 with ranked recommendations for in-range measurements", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({ measurements: VALID_MEASUREMENTS, answers: VALID_ANSWERS });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.topRecommendations)).toBe(true);
    expect(res.body.topRecommendations.length).toBeGreaterThan(0);
  });

  it("accepts the exact min/max boundary values", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: {
          noseWidth: 20,
          noseHeight: 70,
          noseToChin: 40,
          mouthWidth: 80,
          faceWidthAtCheekbones: 110,
          calibrationMethod: "iris",
        },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects an out-of-range (too small) noseWidth with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseWidth: 5 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
    expect(res.body.details.join(" ")).toContain("noseWidth");
  });

  it("rejects an absurdly large faceWidthAtCheekbones with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, faceWidthAtCheekbones: 5000 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("faceWidthAtCheekbones");
  });

  it("rejects a negative measurement with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseToChin: -10 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseToChin");
  });

  // ── Per-field boundary coverage ─────────────────────────────────────────
  // The guard iterates PLAUSIBILITY_BOUNDS and short-circuits on the first
  // violation, returning exactly one details entry. Tests below exercise
  // the remaining fields not covered above and verify both the
  // min and max extremes.

  it("accepts noseWidth at its upper bound (60 mm)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseWidth: 60 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects noseWidth just above its upper bound (61 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseWidth: 61 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseWidth");
  });

  it("accepts noseHeight at its lower bound (25 mm)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseHeight: 25 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects noseHeight below its lower bound (24 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseHeight: 24 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseHeight");
  });

  it("rejects noseHeight above its upper bound (71 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseHeight: 71 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseHeight");
  });

  it("accepts noseToChin at its upper bound (90 mm)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseToChin: 90 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects noseToChin above its upper bound (91 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseToChin: 91 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("noseToChin");
  });

  it("accepts mouthWidth at its lower bound (30 mm)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, mouthWidth: 30 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects mouthWidth below its lower bound (29 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, mouthWidth: 29 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("mouthWidth");
  });

  it("accepts faceWidthAtCheekbones at its upper bound (180 mm)", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, faceWidthAtCheekbones: 180 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(200);
  });

  it("rejects faceWidthAtCheekbones above its upper bound (181 mm) with 400", async () => {
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, faceWidthAtCheekbones: 181 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    expect(res.body.details.join(" ")).toContain("faceWidthAtCheekbones");
  });

  it("error details include the mm unit and the numeric bounds", async () => {
    // Verify the error message format so callers can surface it to users.
    const res = await request(makeApp())
      .post("/recommend")
      .send({
        measurements: { ...VALID_MEASUREMENTS, noseWidth: 5 },
        answers: VALID_ANSWERS,
      });
    expect(res.status).toBe(400);
    const detail = res.body.details[0] as string;
    expect(detail).toContain("measurements.noseWidth");
    expect(detail).toContain("mm");
    expect(detail).toContain("20");
    expect(detail).toContain("60");
  });

  it("returns only one error entry when the first checked field is invalid (early-return behaviour)", async () => {
    // The guard short-circuits on the first violation; the response
    // details array must have exactly one entry, not one per field.
    const res = await request(makeApp())
      .post("/recommend")
      .send({
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
