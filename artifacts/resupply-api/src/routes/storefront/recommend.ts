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
