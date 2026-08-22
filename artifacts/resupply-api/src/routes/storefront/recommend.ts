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
import { verifyFitterInviteToken } from "../../lib/fitter-invite-token.js";
import {
  ADULT_PLAUSIBILITY_BOUNDS,
  PLAUSIBILITY_FIELDS,
} from "../../lib/fitting/index.js";

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
  // Invitation-only gate. The virtual mask fitter is reachable only
  // through a signed invite link a DME company (a Breathe customer)
  // sends a patient by SMS or email; the link carries a token bound to
  // a fitter_invites row (see lib/fitter-invite-token.ts). Without a
  // valid, unexpired token the fitter cannot be used — this is the
  // server-side counterpart to the client route guard in the SPA, so
  // the gate can't be bypassed by deep-linking or seeding storage.
  //
  // The check is intentionally STATELESS (HMAC signature + expiry, no
  // DB read) to preserve this route's no-persistence design: a genuine
  // signature proves an invite was actually issued, which is the bar
  // for "you were invited". Revocation/status enforcement stays on the
  // stateful resolve/complete endpoints that attach results to a chart.
  const inviteToken = req.header("x-fitter-invite-token");
  const verification =
    typeof inviteToken === "string"
      ? verifyFitterInviteToken(inviteToken)
      : null;
  if (!verification?.valid) {
    res.status(403).json({
      error:
        "The virtual mask fitter is available by invitation only. Ask your local DME company for an invite link or code.",
    });
    return;
  }

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

  // Plausibility guard: defense-in-depth for direct API callers. The
  // browser rejects out-of-window measurements before sending
  // (PLAUSIBILITY_BOUNDS in cpap-fitter's measure-flow.ts), but this
  // endpoint is stateless and public — a direct caller bypasses that
  // entirely. Zod enforces the shape; this rejects numerically
  // out-of-range values before they reach the recommender.
  //
  // The ADULT window, deliberately: this legacy route has no chart and
  // no date of birth, and its recommendation engine has no pediatric
  // service line, so it must not start sizing adult masks for children.
  // A pediatric face is turned away here and fitted through
  // /api/fit/assess, which does know the population. Imported rather
  // than transcribed — the copies of this table are what drifted apart.
  for (const field of PLAUSIBILITY_FIELDS) {
    const [min, max] = ADULT_PLAUSIBILITY_BOUNDS[field];
    const value = measurements[field];
    if (!Number.isFinite(value) || value < min || value > max) {
      res.status(400).json({
        // The SPA renders this `error` string verbatim as the permanent
        // failure message — a smaller-than-adult face (a teenager on the
        // legacy path) used to dead-end on a bare "Invalid input" with no
        // idea what to do next.
        error:
          "These measurements fall outside the range this fitting tool can size. " +
          "Retaking the photo sometimes helps; otherwise ask your provider to fit you in person.",
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
