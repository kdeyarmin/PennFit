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
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  PLAUSIBILITY_FIELDS,
} from "../../lib/fitting/index.js";
import { loadCatalogVisibility } from "../../lib/fitting/catalog-store.js";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org.js";
import { requestHost } from "../../lib/request-host.js";
import { resolveOrgIdByHost } from "../../lib/tenant-branding.js";
import { storefrontRecommendLimiter } from "../../middlewares/storefront-rate-limit.js";

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
router.post(
  "/recommend",
  // The shared mask-scoring limiter (60/min per IP), applied HERE rather
  // than app-level: this handler performs authorization, and a limiter
  // mounted in app.ts is invisible both to a reader of this file and to
  // CodeQL's js/missing-rate-limiting query. Same instance `/api/fit/*`
  // uses, so the two paths still share one bucket.
  storefrontRecommendLimiter,
  async (req, res) => {
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
    // Omitted means adult — see the field's note on GetRecommendationBody.
    const population = parseResult.data.population ?? "adult";

    // Plausibility guard: defense-in-depth for direct API callers. The
    // browser rejects out-of-window measurements before sending
    // (PLAUSIBILITY_BOUNDS in cpap-fitter's measure-flow.ts), but this
    // endpoint is stateless and public — a direct caller bypasses that
    // entirely. Zod enforces the shape; this rejects numerically
    // out-of-range values before they reach the recommender.
    //
    // The window follows the POPULATION the patient just told us about.
    //
    // Before the adult-or-child question existed this was hardcoded to the
    // adult window, deliberately: the route had no way to know it was
    // looking at a child, so admitting a child-sized face would have meant
    // sizing adult masks for children. Now that the session states its
    // service line, a pediatric face is measured against pediatric bounds
    // and turned away one step LATER — by the engine's service-line filter,
    // which returns nothing because this catalog is adult-only — so the SPA
    // can say "we can't fit a child here, a representative will call you"
    // instead of blaming the photo for a measurement that was fine.
    // Imported rather than transcribed — the copies of this table are what
    // drifted apart.
    const plausibilityBounds =
      population === "pediatric"
        ? PEDIATRIC_PLAUSIBILITY_BOUNDS
        : ADULT_PLAUSIBILITY_BOUNDS;
    for (const field of PLAUSIBILITY_FIELDS) {
      const [min, max] = plausibilityBounds[field];
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

    // Masks the tenant hid (formulary `exclude`, migration 0516) are dropped
    // before scoring, so this legacy engine agrees with /api/fit/assess about
    // what the provider actually carries. Resolved from the invite's OWN
    // tenant rather than the request host, so a fitter opened on the platform
    // domain still honours the inviting DME's formulary.
    //
    // This is a read, and it does not weaken the stateless gate above: the
    // invite is still accepted on its signature alone, and a lookup that
    // fails or times out simply hides nothing. The route's no-persistence
    // design is untouched — nothing here writes.
    const orgId = await resolveOrgIdForSignedRecord(
      "fitter_invites",
      verification.inviteId,
    ).catch(() => null);
    const visibility = await loadCatalogVisibility(orgId);

    // Population is a HARD filter in the engine too, matching tier 1 of
    // the clinical path. For a pediatric session against this adult-only
    // catalog that yields an empty ranking, which is the honest answer:
    // the array carries no pediatric interfaces and no pediatric size
    // bands, so there is nothing here that could be fitted to a child.
    const result = recommend(measurements, answers, {
      population,
      hiddenMaskIds: visibility.hiddenSlugs,
    });

    res.json({
      ...result,
      // Echoed so the SPA can distinguish "nothing ranked for a CHILD on a
      // catalog that has no children's masks" (refer to the DME) from
      // "nothing ranked for an adult" (a measurement problem — retake).
      // Reading it off the response rather than off the request means a
      // future server-side override (a chart-linked date of birth, say)
      // reaches the patient's screen instead of being silently disagreed
      // with by the client's own copy.
      population,
    });
  },
);

/**
 * GET /api/masks
 *
 * Returns the mask catalog this tenant carries. Public, no PHI involved.
 *
 * Tenant resolves by HOST — there is no token on this route — so a request
 * that lands on the platform domain, or on a host with no tenant behind it,
 * gets the unfiltered catalog. Fail-open is the right default for a public
 * listing: this is a merchandising preference, not an access control.
 */
router.get("/masks", async (req, res) => {
  const orgId = await resolveOrgIdByHost(requestHost(req)).catch(() => null);
  const visibility = await loadCatalogVisibility(orgId);
  const masks = visibility.hiddenSlugs.size
    ? maskCatalog.filter((m) => !visibility.hiddenSlugs.has(m.id))
    : maskCatalog;

  // The body now varies by tenant, and the custom domains sit behind
  // Cloudflare — without this an edge cache could serve one tenant's
  // filtered catalog to another. Same posture as GET /api/fit/catalog.
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Host");
  res.json({
    masks,
    total: masks.length,
  });
});

export default router;
