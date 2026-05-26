/**
 * INTENTIONAL ARCHITECTURE NOTE — HIPAA Data Minimization
 *
 * This route is STATELESS by design. We accept ONLY:
 *   - Numeric facial measurements (derived on-device, never images)
 *   - Questionnaire answers (boolean/enum values)
 *
 * We do NOT:
 *   - Accept, store, or process images in any form
 *   - Log request bodies (pino-http serializer excludes body)
 *   - Write any patient data to a database
 *   - Persist session data
 *
 * This minimizes PHI exposure.
 */

import { Router } from "express";
import { GetRecommendationBody } from "../../lib/api-zod/index.js";
import { recommend } from "../../lib/storefront/recommendationEngine.js";
import { maskCatalog } from "../../data/maskCatalog.js";

// Server-side plausibility bounds (millimeters). The browser rejects
// out-of-window measurements before sending (PLAUSIBILITY_BOUNDS in
// artifacts/cpap-fitter/src/lib/measure-flow.ts), but this endpoint is
// stateless and public — a direct caller bypasses that guard entirely.
// Generous enough to cover ~99% of adult faces while rejecting
// negative / zero / absurd values that would otherwise feed garbage into
// the recommender. Keep in sync with the client copy.
type BoundedMeasurement =
  | "noseWidth"
  | "noseHeight"
  | "noseToChin"
  | "mouthWidth"
  | "faceWidthAtCheekbones";

const PLAUSIBILITY_BOUNDS = {
  noseWidth: [20, 60],
  noseHeight: [25, 70],
  noseToChin: [40, 90],
  mouthWidth: [30, 80],
  faceWidthAtCheekbones: [110, 180],
} as const satisfies Record<BoundedMeasurement, readonly [number, number]>;

const router = Router();

/**
 * POST /api/recommend
 *
 * Accepts numeric measurements and questionnaire answers.
 * Returns ranked mask recommendations. Stateless — no data persisted.
 *
 * Strict input validation via Zod. Any payload containing image data,
 * base64 strings, binary, or unexpected fields is rejected with 400.
 */
router.post("/recommend", (req, res) => {
  // Zod validation — rejects unexpected fields (strict mode) and validates types
  const parseResult = GetRecommendationBody.safeParse(req.body);

  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid input",
      details: parseResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }

  // Additional guard: reject any base64, binary, or blob-like content
  // (should never reach here with Zod strict validation, but belt-and-suspenders)
  const bodyStr = JSON.stringify(req.body);
  const base64Pattern = /data:[a-z]+\/[a-z]+;base64,/i;
  const longStringPattern = /[A-Za-z0-9+/]{1000,}/; // typical base64 is very long
  if (base64Pattern.test(bodyStr) || longStringPattern.test(bodyStr)) {
    res.status(400).json({
      error:
        "Request body contains unexpected binary or encoded data. Only numeric measurements are accepted.",
    });
    return;
  }

  const { measurements, answers } = parseResult.data;

  // Plausibility guard: defense-in-depth for direct API callers that
  // bypass the on-device measurement window. Zod enforces the shape;
  // this rejects numerically out-of-range values before they reach the
  // recommender.
  for (const field of Object.keys(PLAUSIBILITY_BOUNDS) as BoundedMeasurement[]) {
    const [min, max] = PLAUSIBILITY_BOUNDS[field];
    const value = measurements[field];
    if (!Number.isFinite(value) || value < min || value > max) {
      res.status(400).json({
        error: "Invalid input",
        details: [
          `measurements.${field}: must be a number between ${min} and ${max} mm`,
        ],
      });
      return;
    }
  }

  const result = recommend(measurements, answers);

  res.json(result);
});

/**
 * GET /api/masks
 *
 * Returns the full mask catalog. Public, no PHI involved.
 */
router.get("/masks", (_req, res) => {
  res.json({
    masks: maskCatalog,
    total: maskCatalog.length,
  });
});

export default router;
