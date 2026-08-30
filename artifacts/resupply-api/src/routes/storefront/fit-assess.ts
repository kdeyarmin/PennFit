/**
 * POST /api/fit/assess — the clinical fitting assessment.
 * GET  /api/fit/catalog — the tenant's formulary-filtered mask catalog.
 *
 * RELATIONSHIP TO /api/recommend
 * ------------------------------
 * `/api/recommend` is untouched and still serves every tenant that has not
 * enabled `fitter.clinical_assessment`. This is the opt-in path. Splitting
 * them rather than growing the old one means the legacy behaviour is
 * preserved byte-for-byte and a rollback is a flag flip, not a deploy.
 *
 * PHI POSTURE — read this before changing anything here
 * ----------------------------------------------------
 * Unlike `/api/recommend`, this endpoint IS stateful: it writes a
 * `fit_sessions` row. That is a deliberate change, and it is what the
 * clinical report, the RT review queue, and the audit history all require —
 * none of which can be built on an endpoint that keeps nothing.
 *
 * It introduces no NEW class of PHI: `fitter_invites` already persists the
 * same facial measurements and questionnaire answers on completion. What
 * has NOT changed:
 *   * No images. Camera frames never leave the browser. The request body
 *     accepts numbers and enums, and the base64/blob guard below rejects
 *     anything that looks like encoded media.
 *   * No request bodies in the logger.
 *
 * FAILURE POSTURE
 * ---------------
 * The catalog load is best-effort with a hard timeout and a static-catalog
 * fallback (`catalog-store.ts`), and the session write is fire-and-forget.
 * A database outage degrades the answer; it never 500s a patient
 * mid-fitting and never hangs one. That is the service-boot contract: the
 * storefront must not hard-depend on the database.
 */

import { Router, type IRouter } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyFitterInviteToken } from "../../lib/fitter-invite-token.js";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org.js";
import { getFeatureFlagState } from "../../lib/feature-flags.js";
import {
  loadFitAdjustments,
  loadFittingContext,
} from "../../lib/fitting/catalog-store.js";
import {
  completeInviteFromFitting,
  toLegacyMaskType,
} from "../../lib/fitting/complete-invite.js";
import {
  ADULT_PLAUSIBILITY_BOUNDS,
  assess,
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  resolveCatalogVisibility,
} from "../../lib/fitting/index.js";
import { buildProfile } from "../../lib/fitting/profile.js";
import { RULES_ENGINE_VERSION } from "../../lib/fitting/versions.js";
import type {
  ExclusionRecord,
  FitAssessment,
  FitCandidate,
  FitMeasurements,
  SafetyResponse,
  ScanSignals,
} from "../../lib/fitting/types.js";

const router: IRouter = Router();

// Public PHI-writing endpoint — cap replays of a single valid token.
// Generous enough for real retakes (a patient re-scanning a handful of
// times, two POSTs per fitting when the safety screen runs), tight
// enough that one leaked token can't be used to spray unbounded
// fit_sessions rows.
//
// Keyed by the VERIFIED invite when the token checks out, so the cap is
// genuinely per-invitation — an IP key would pool every patient behind
// one clinic Wi-Fi / carrier NAT into a single bucket and 429 unrelated
// valid fittings. Requests without a valid token (which the handler will
// 403 anyway) still share the caller's IP bucket.
const assessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.header("x-fitter-invite-token");
    const verified =
      typeof token === "string" ? verifyFitterInviteToken(token) : null;
    return verified?.valid
      ? `invite:${verified.inviteId}`
      : ipKeyGenerator(req.ip ?? "");
  },
});

const measurementsSchema = z
  .object({
    noseWidth: z.number().finite(),
    noseHeight: z.number().finite(),
    noseToChin: z.number().finite(),
    mouthWidth: z.number().finite(),
    faceWidthAtCheekbones: z.number().finite(),
    calibrationMethod: z.enum(["creditCard", "iris", "manual"]).optional(),
  })
  .strict();

const scanSchema = z
  .object({
    frameCount: z.number().int().min(1).max(10),
    quality: z
      .object({
        lighting: z.number().min(0).max(1).optional(),
        distance: z.number().min(0).max(1).optional(),
        pose: z.number().min(0).max(1).optional(),
        occlusion: z.number().min(0).max(1).optional(),
        motion: z.number().min(0).max(1).optional(),
        framing: z.number().min(0).max(1).optional(),
      })
      .strict()
      .default({}),
    agreement: z
      .object({
        noseWidth: z.number().min(0).max(1).optional(),
        noseHeight: z.number().min(0).max(1).optional(),
        noseToChin: z.number().min(0).max(1).optional(),
        mouthWidth: z.number().min(0).max(1).optional(),
        faceWidthAtCheekbones: z.number().min(0).max(1).optional(),
      })
      .strict()
      .default({}),
    measurementConfidence: z.number().min(0).max(1),
    band: z.enum(["high", "moderate", "low"]),
  })
  .strict();

const legacyAnswersSchema = z
  .object({
    mouthBreather: z.boolean().nullable().optional(),
    claustrophobic: z.boolean().nullable().optional(),
    sideOrStomachSleeper: z.boolean().nullable().optional(),
    heavyFacialHair: z.boolean().nullable().optional(),
    wearsGlasses: z.boolean().nullable().optional(),
    frequentCongestion: z.boolean().nullable().optional(),
    priorMaskExperience: z
      .enum(["none", "nasal", "nasalPillow", "fullFace", "hybrid"])
      .optional(),
    mobilityLimitations: z.boolean().nullable().optional(),
    sensitiveSkin: z.boolean().nullable().optional(),
    siliconeSensitivity: z.boolean().nullable().optional(),
    cpapPressureSetting: z
      .enum(["unknown", "low", "medium", "high"])
      .optional(),
  })
  .strict();

const profileSchema = z
  .object({
    version: z.string().max(64).optional(),
    population: z.enum(["adult", "pediatric"]).optional(),
    therapyMode: z.enum(["pap", "niv"]).optional(),
    therapyDevice: z
      .enum(["cpap", "apap", "bilevel", "asv", "unknown"])
      .optional(),
    pressureCmH2O: z.number().min(0).max(40).nullable().optional(),
    pressureBand: z.enum(["unknown", "low", "medium", "high"]).optional(),
    supplementalOxygen: z.boolean().nullable().optional(),
    mouthBreather: z.boolean().nullable().optional(),
    nasalObstruction: z
      .enum(["none", "seasonal", "chronic", "post_surgical"])
      .nullable()
      .optional(),
    frequentCongestion: z.boolean().nullable().optional(),
    dryMouth: z.boolean().nullable().optional(),
    sleepPositions: z
      .array(z.enum(["back", "side", "stomach", "mixed"]))
      .max(4)
      .optional(),
    claustrophobia: z.enum(["none", "mild", "severe"]).nullable().optional(),
    minimalContactPreference: z
      .enum(["minimal", "traditional", "no_preference"])
      .nullable()
      .optional(),
    facialHair: z
      .enum(["none", "stubble", "moustache", "full_beard"])
      .nullable()
      .optional(),
    dentures: z.boolean().nullable().optional(),
    facialStructureChange: z.boolean().nullable().optional(),
    skinIrritation: z
      .enum(["none", "irritation", "pressure_sore"])
      .nullable()
      .optional(),
    sensitiveSkin: z.boolean().nullable().optional(),
    siliconeSensitivity: z.boolean().nullable().optional(),
    wearsGlasses: z.boolean().nullable().optional(),
    priorMaskExperience: z
      .enum(["none", "nasal", "nasalPillow", "fullFace", "hybrid"])
      .optional(),
    priorMaskModelSlug: z.string().max(120).nullable().optional(),
    priorMaskSize: z.string().max(32).nullable().optional(),
    priorLeakLocations: z
      .array(z.enum(["bridge_of_nose", "cheeks", "sides", "mouth", "chin"]))
      .max(5)
      .optional(),
    priorMaskSatisfaction: z.number().int().min(1).max(5).nullable().optional(),
    headgearDifficulty: z.boolean().nullable().optional(),
    handDexterity: z
      .enum(["normal", "limited", "caregiver_assisted"])
      .nullable()
      .optional(),
    visionOrCognitiveLimitation: z.boolean().nullable().optional(),
  })
  .strict();

const safetySchema = z
  .object({
    screenVersion: z.string().max(64),
    attestedAt: z.string().datetime().optional(),
    responses: z
      .array(
        z
          .object({
            questionKey: z.string().max(120),
            answer: z.enum(["yes", "no", "unsure"]),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

const assessBodySchema = z
  .object({
    measurements: measurementsSchema,
    answers: legacyAnswersSchema.optional(),
    profile: profileSchema.optional(),
    /**
     * Adult or child, asked at the head of the questionnaire.
     *
     * It also exists inside `profile`, and both carry the same value —
     * but only the v2 client sends a `profile` block at all, and
     * `buildProfile` stamps any profile it receives as a v2 profile
     * (which decides the question set the fit report cites). Sending a
     * one-field profile just to carry the population would therefore
     * make every LEGACY-questionnaire fitting claim it answered the v2
     * question set. Hence a top-level field: a session property,
     * transmitted as one, on both question sets.
     */
    population: z.enum(["adult", "pediatric"]).optional(),
    scan: scanSchema.optional(),
    safety: safetySchema.optional(),
    entryPoint: z
      .enum(["remote_link", "in_office", "kiosk_qr", "refit_campaign"])
      .optional(),
  })
  .strict();

/**
 * Belt-and-braces guard against encoded media. Zod's strict mode already
 * rejects unknown keys, so nothing should reach here — but "no images in
 * the backend" is a hard rule, and a hard rule deserves a second check
 * that does not depend on a schema staying correct.
 */
function looksLikeEncodedMedia(body: unknown): boolean {
  const s = JSON.stringify(body ?? {});
  return (
    /data:[a-z]+\/[a-z]+;base64,/i.test(s) || /[A-Za-z0-9+/]{1000,}/.test(s)
  );
}

const NEUTRAL_SCAN: ScanSignals = {
  frameCount: 1,
  quality: {},
  agreement: {},
  // A single unverified frame is treated as moderate, not perfect: without
  // cross-frame agreement there is no evidence the measurement is stable.
  measurementConfidence: 0.7,
  band: "moderate",
};

router.post("/fit/assess", assessLimiter, async (req, res) => {
  // ── Gate first, exactly as the legacy route does. Stateless HMAC, no
  //    DB read: a valid signature proves an invite was issued, which is
  //    the bar for "you were invited". Revocation stays on the stateful
  //    resolve/complete endpoints. ──
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

  const parsed = assessBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid input",
      details: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }
  if (looksLikeEncodedMedia(req.body)) {
    res.status(400).json({
      error:
        "Request body contains unexpected binary or encoded data. Only numeric measurements are accepted.",
    });
    return;
  }

  const body = parsed.data;
  let profile = buildProfile(body.answers ?? null, body.profile ?? null);

  // The explicit session field outranks whatever the profile mapping
  // produced — `emptyProfile()` defaults to "adult" for back-compat, and
  // that default must not survive a patient telling us otherwise. Still
  // below the chart override applied further down: a date of birth on a
  // linked chart beats anything the browser says.
  if (body.population) {
    profile = { ...profile, population: body.population };
  }

  const measurements: FitMeasurements = {
    noseWidth: body.measurements.noseWidth,
    noseHeight: body.measurements.noseHeight,
    noseToChin: body.measurements.noseToChin,
    mouthWidth: body.measurements.mouthWidth,
    faceWidthAtCheekbones: body.measurements.faceWidthAtCheekbones,
  };

  const orgId = await resolveOrgIdForSignedRecord(
    "fitter_invites",
    verification.inviteId,
  ).catch(() => null);

  if (!orgId) {
    // Fail soft with a 200 body the SPA can render, matching
    // routes/shop/fitter-invite.ts — a patient never sees a stack trace.
    res.json({ valid: false, reason: "tenant_unavailable" });
    return;
  }

  // STATEFUL invite check. The HMAC above only proves an invite was once
  // issued; it says nothing about whether it still stands. Unlike
  // /api/recommend — which is stateless and writes nothing — this endpoint
  // PERSISTS a PHI-bearing session, so accepting a revoked or expired token
  // would keep recording patient data after staff explicitly stopped it
  // (easily reachable from a tab left open when the revoke happened).
  // /shop/fitter-invite/resolve already enforces this; so must we.
  const invite = await loadInvite(orgId, verification.inviteId);
  if (invite === "unavailable") {
    // A DB blip, not a dead invite — the SPA maps this to its retryable
    // "couldn't finish your fitting just now" screen, never the
    // permanent "ask your DME to resend it" dead end.
    res.json({ valid: false, reason: "invite_lookup_unavailable" });
    return;
  }
  if (!invite) {
    res.json({ valid: false, reason: "invite_not_found" });
    return;
  }
  if (invite.status === "revoked") {
    res.json({ valid: false, reason: "revoked" });
    return;
  }
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) {
    res.json({ valid: false, reason: "expired" });
    return;
  }

  // The chart outranks the client's self-reported population. Population
  // selects the plausibility windows, the tier-1 service-line filter, and
  // the stored column — for a chart-linked fitting all of that should
  // follow the patient's date of birth, not a browser-supplied hint.
  if (invite.chartPopulation && invite.chartPopulation !== profile.population) {
    profile = { ...profile, population: invite.chartPopulation };
  }

  // Population is asked, never assumed — same contract as /api/recommend.
  // Chart-linked invites may supply it from date of birth; otherwise the
  // client must send the questionnaire gate answer explicitly.
  if (!invite.chartPopulation && !body.population) {
    res.status(400).json({
      error: "Invalid input",
      details: ["population: required (adult or pediatric)"],
    });
    return;
  }

  // Grossly impossible numbers are rejected outright — they indicate a
  // broken or hostile client, not a patient. Values that are merely
  // outside the sizing window fall through to the engine, which returns
  // `outside_validated_range` and says so plainly.
  //
  // Deliberately AFTER the chart-population override above: the windows
  // are population-specific, and picking them from the client-claimed
  // population meant a pediatric chart with a browser-supplied "adult"
  // hint was gross-checked against adult windows (and vice versa).
  // Imported, not transcribed: these used to be a hand-copied pair in
  // this file, which is how the pediatric ceilings drifted below the
  // adult ones. See lib/fitting/confidence.ts.
  const bounds =
    profile.population === "pediatric"
      ? PEDIATRIC_PLAUSIBILITY_BOUNDS
      : ADULT_PLAUSIBILITY_BOUNDS;
  for (const [field, [, max]] of Object.entries(bounds)) {
    const value = measurements[field as keyof FitMeasurements];
    if (value <= 0 || value > max * 3) {
      res.status(400).json({
        error: "Invalid input",
        details: [
          `measurements.${field}: must be a positive number no greater than ${max * 3} mm`,
        ],
      });
      return;
    }
  }

  // Fail toward SAFETY on all three flags: `isFeatureEnabled` never
  // rejects (it absorbs every failure into its own fail-closed-to-false
  // posture), so the old `.catch(() => true)` on the magnet flag was dead
  // code and a production flag-store blip silently resolved
  // `fitter.magnet_screening` to false — disabling the implant screen for
  // the very requests it was supposed to protect. `getFeatureFlagState`
  // surfaces the degradation explicitly; `enabled || degraded` means a
  // failed lookup runs the SAFEST configuration (clinical path on, gating
  // on, screening required) while a tenant's explicit opt-out — a real
  // row that read false — is still honored.
  const [enabledState, gatingState, magnetState] = await Promise.all([
    getFeatureFlagState("fitter.clinical_assessment", orgId),
    getFeatureFlagState("fitter.confidence_gating", orgId),
    getFeatureFlagState("fitter.magnet_screening", orgId),
  ]);
  const enabled = enabledState.enabled || enabledState.degraded;
  const gating = gatingState.enabled || gatingState.degraded;
  const magnets = magnetState.enabled || magnetState.degraded;
  if (!enabled) {
    res.status(404).json({
      error:
        "The clinical fitting assessment is not enabled for this provider.",
    });
    return;
  }

  const context = await loadFittingContext(orgId);

  // The #22b closed loop, live: per-mask ranking multipliers from this
  // tenant's attributed post-fit outcomes ("every fitting builds on the
  // last"). Keyed by slug for the engine; fail-soft neutral `{}`; bounded
  // to ±15% inside the engine regardless, so feedback can re-order
  // near-ties but can never rescue a clinically poor mask.
  const fitAdjustments = await loadFitAdjustments(orgId, context.catalog);

  const safetyResponses: SafetyResponse[] = (body.safety?.responses ?? []).map(
    (r) => ({ questionKey: r.questionKey, answer: r.answer }),
  );

  // When magnet screening is enabled, an absent or partial screen must NOT
  // silently resolve to "no risk". `resolveSafetyFlags` only disqualifies on
  // questions it actually has answers for, so an omitted screen would let a
  // magnetic mask through with the feature nominally ON — the exact failure
  // the screen exists to prevent. Withhold instead.
  if (magnets && context.safetyScreen) {
    const screen = context.safetyScreen;
    const answered = new Set(safetyResponses.map((r) => r.questionKey));
    const missing = screen.questions
      .map((q) => q.questionKey)
      .filter((k) => !answered.has(k));
    const versionMatches = body.safety?.screenVersion === screen.version;
    if (!body.safety || !versionMatches || missing.length > 0) {
      res.json({
        valid: false,
        reason: "safety_screen_required",
        safetyScreen: {
          slug: screen.slug,
          version: screen.version,
          title: screen.title,
          introCopy: screen.introCopy,
          attestationCopy: screen.attestationCopy,
          questions: screen.questions.map((q) => ({
            questionKey: q.questionKey,
            prompt: q.prompt,
            helpText: q.helpText,
            subject: q.subject,
            sortOrder: q.sortOrder,
          })),
        },
        missingQuestionKeys: missing,
        staleVersion: Boolean(body.safety) && !versionMatches,
      });
      return;
    }
  }

  const assessment = assess({
    measurements,
    profile,
    scan: body.scan ?? NEUTRAL_SCAN,
    catalog: context.catalog,
    formulary: context.formulary,
    // The formulary resolver advertises five scope axes, so the live path
    // has to actually supply them — a rule scoped to a location or payer
    // that can never fire is worse than no rule, because the operator sees
    // it saved and assumes it works. Location and payer come from the
    // patient's chart when the invite is attached to one; both stay null
    // for an unattached prospect, and `ruleApplies` correctly declines to
    // fire scoped rules on unknown values rather than guessing.
    context: {
      locationId: invite.locationId,
      payerProfileId: invite.payerProfileId,
      contractRef: null,
      population: profile.population,
      therapyMode: profile.therapyMode,
      asOf: new Date().toISOString().slice(0, 10),
    },
    safetyScreen: context.safetyScreen,
    safetyResponses,
    // Screening is ON but the screen itself failed to load (DB blip, the
    // degraded static path, a missing question set). The withhold above
    // only covers a screen that LOADED with missing answers; without this
    // the unloadable-screen case silently resolved to "no risk" and a
    // magnetic mask could reach an unscreened implant patient. The engine
    // fails closed by excluding magnetic masks, with the reason recorded.
    magnetScreenUnavailable: magnets && !context.safetyScreen,
    availability: context.availability,
    fitAdjustments,
    degraded: context.degraded,
    confidenceGating: gating,
    magnetScreening: magnets,
  });

  // Persist the clinical record. Fire-and-forget on purpose: a DB blip
  // must not cost the patient their fitting. The response carries the
  // session id when the write landed so the SPA can deep-link the report.
  const sessionId = await persistSession({
    orgId,
    inviteId: verification.inviteId,
    patientId: invite.patientId,
    locationId: invite.locationId,
    payerProfileId: invite.payerProfileId,
    // The INVITE decides how the fitting started, not the client. An
    // in-office invite is one staff deliberately raised as a counter
    // handover, which is a fact the server already knows; `body.entryPoint`
    // is a self-reported hint from the patient's own browser and would let
    // remote fittings be miscounted as in-office in the outcome reporting.
    entryPoint:
      invite.channel === "in_office"
        ? "in_office"
        : (body.entryPoint ?? "remote_link"),
    measurements,
    answers: body.answers,
    profile,
    scan: body.scan ?? NEUTRAL_SCAN,
    assessment,
    safety: body.safety
      ? {
          screenVersion: body.safety.screenVersion,
          attestedAt: body.safety.attestedAt ?? null,
          responses: safetyResponses,
          snapshot: context.safetyScreen,
        }
      : null,
    calibrationMethod: body.measurements.calibrationMethod ?? null,
  });

  res.json({
    ...projectAssessment(assessment),
    fitSessionId: sessionId,
    // The EFFECTIVE service line, after the chart override above — not
    // whatever the browser claimed. This is what the engine filtered on
    // and what the fit session records, so anything the SPA files later
    // (a fit request, its queue badge, the team email) has to agree with
    // it. Without this a chart-linked pediatric fitting could be filed
    // as an adult request, or the reverse.
    population: profile.population,
  });
});

/**
 * Project the assessment for the patient's browser.
 *
 * The STORED record keeps every internal term — the review queue and the
 * fit report need them. The response must not: `rankScore` bakes in the
 * formulary preference and inventory margin rank (publishing it lets
 * anyone reconstruct the DME's commercial ordering, undoing the
 * "commercial signals never reach the patient" invariant),
 * `formularyRulesMatched` is internal rule ids, `formularyExcludedSlugs`
 * is the list of masks the provider chose not to carry (publishing it to
 * the patient would undo the hiding it records), and `clinicianReason` is
 * the staff-facing wording. None of them are consumed by the SPA.
 */
function projectAssessment(assessment: FitAssessment): Omit<
  FitAssessment,
  "primary" | "alternatives" | "excluded" | "provenance"
> & {
  primary: Partial<FitCandidate> | null;
  alternatives: Partial<FitCandidate>[];
  excluded: Omit<ExclusionRecord, "clinicianReason">[];
  provenance: Omit<
    FitAssessment["provenance"],
    "formularyRulesMatched" | "formularyExcludedSlugs"
  >;
} {
  const candidate = ({
    rankScore: _rankScore,
    facialFitScore: _facialFitScore,
    patientFactorScore: _patientFactorScore,
    ...pub
  }: FitCandidate) => pub;
  // Both of these are clinician/audit-only. `formularyExcludedSlugs` in
  // particular is the list of masks the provider chose not to carry —
  // handing it to the patient would undo the hiding it records.
  const {
    formularyRulesMatched: _rules,
    formularyExcludedSlugs: _hidden,
    ...provenance
  } = assessment.provenance;
  return {
    ...assessment,
    primary: assessment.primary ? candidate(assessment.primary) : null,
    alternatives: assessment.alternatives.map(candidate),
    excluded: assessment.excluded.map(
      ({ clinicianReason: _clinician, ...ex }) => ex,
    ),
    provenance,
  };
}

/**
 * GET /api/fit/catalog — the tenant's catalog, filtered to what their
 * formulary actually allows. Public and PHI-free: product facts only.
 * Successor to `GET /api/masks`, which stays for back-compatibility.
 */
router.get("/fit/catalog", async (req, res) => {
  const inviteToken = req.header("x-fitter-invite-token");
  const verification =
    typeof inviteToken === "string"
      ? verifyFitterInviteToken(inviteToken)
      : null;
  if (!verification?.valid) {
    res.status(403).json({ error: "Invitation required." });
    return;
  }

  const orgId = await resolveOrgIdForSignedRecord(
    "fitter_invites",
    verification.inviteId,
  ).catch(() => null);
  if (!orgId) {
    res.json({ valid: false, reason: "tenant_unavailable" });
    return;
  }

  // Same stateful check as /fit/assess. Two things depend on it: a
  // revoked or expired invite must stop reading the catalog, and — since
  // resolveOrgIdForSignedRecord falls back to the SEED org when the
  // record is missing — a validly-signed token whose invite row is gone
  // must not be handed the seed tenant's private catalog.
  const invite = await loadInvite(orgId, verification.inviteId);
  if (invite === "unavailable") {
    res.json({ valid: false, reason: "invite_lookup_unavailable" });
    return;
  }
  if (!invite) {
    res.json({ valid: false, reason: "invite_not_found" });
    return;
  }
  if (invite.status === "revoked") {
    res.json({ valid: false, reason: "revoked" });
    return;
  }
  if (invite.expiresAt && Date.parse(invite.expiresAt) < Date.now()) {
    res.json({ valid: false, reason: "expired" });
    return;
  }

  const context = await loadFittingContext(orgId);
  // Masks the tenant does not carry never appear here. This endpoint's whole
  // job is "what can this provider fit you with", and it feeds the fitter's
  // browse/compare UI, so a hidden manufacturer showing up in the list would
  // be exactly the searchable listing the operator turned off. Resolved
  // against the axes the invite actually knows (see below) so this endpoint
  // and /fit/assess never disagree about what the same patient can be
  // shown.
  const visibility = resolveCatalogVisibility(
    context.formulary,
    context.catalog,
    new Date().toISOString().slice(0, 10),
    // The invite carries the location and payer, so pass them: without
    // this, a location-scoped exclusion applied during /fit/assess while
    // /fit/catalog — reached with the SAME token — still listed the mask,
    // and an org-wide exclusion with a location-specific allow hid one the
    // assessment was free to recommend. Population and therapy mode are
    // still genuinely unknown here, so rules scoped to those stay inert.
    { locationId: invite.locationId, payerProfileId: invite.payerProfileId },
  );
  const visibleMasks = context.catalog.filter(
    (m) => !visibility.hiddenSlugs.has(m.slug),
  );
  // The body varies by the tenant behind the invite token and can include a
  // tenant's PRIVATE mask models and formulary metadata. Both custom domains
  // sit behind Cloudflare, so `public` here would let an edge cache serve
  // tenant A's catalog to tenant B. Private + no-store; the 60s in-process
  // cache in catalog-store already absorbs the real load.
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "x-fitter-invite-token");
  res.json({
    total: visibleMasks.length,
    degraded: context.degraded,
    formulary: {
      name: context.formulary.name,
      version: context.formulary.version,
    },
    masks: visibleMasks.map((m) => ({
      slug: m.slug,
      manufacturer: m.manufacturer,
      modelName: m.modelName,
      interfaceType: m.interfaceType,
      serviceLine: m.serviceLine,
      therapyModes: m.therapyModes,
      vented: m.vented,
      hasMagneticComponents: m.hasMagneticComponents,
      minimalContact: m.minimalContact,
      avoidsNasalBridge: m.avoidsNasalBridge,
      pressureMin: m.pressureMin,
      pressureMax: m.pressureMax,
      status: m.status,
      imageUrl: m.imageUrl,
      description: m.description,
      sizes: m.variants
        .filter((v) => v.component !== "frame")
        .map((v) => ({
          code: v.sizeCode,
          label: v.sizeLabel,
          partNumber: v.manufacturerPartNumber,
        })),
    })),
  });
});

interface InviteContext {
  patientId: string | null;
  locationId: string | null;
  payerProfileId: string | null;
  status: string;
  expiresAt: string | null;
  /** How the invite was raised (migration 0489). Authoritative over the
   *  client's `entryPoint` hint — see where it's resolved below. */
  channel: string | null;
  /** The chart's own adult/pediatric classification, from date_of_birth.
   *  Authoritative over the client's self-reported `population` when the
   *  invite is chart-linked: population selects the plausibility windows,
   *  the tier-1 service-line filter, and the stored column, and none of
   *  those should follow a browser-supplied hint when the chart knows. */
  chartPopulation: "adult" | "pediatric" | null;
}

/**
 * Load the invite row behind a verified token.
 *
 * Supplies three things the stateless HMAC cannot: whether the invite is
 * still live, which chart it belongs to, and the location/payer that scope
 * the tenant's formulary rules.
 *
 * A FAILED lookup is not a MISSING row: returning null for both used to
 * tell a patient mid-fitting that their invite "couldn't be found" — a
 * permanent-sounding dead end ("ask your DME company to resend it") —
 * whenever the database blinked, when the truth was "try again in a
 * moment". `"unavailable"` routes to the retryable screen instead. Never
 * throws, so the caller still can't 500 a patient.
 */
/**
 * Adult or pediatric from a date of birth, by the calendar.
 *
 * Exported for its own test: the boundary is a real clinical switch (it
 * selects the service line a patient is fitted on), and an off-by-a-day
 * there is invisible in every other test.
 */
export function classifyPopulationFromDob(
  dateOfBirth: string,
  fallback: "adult" | "pediatric" | null = null,
  now: Date = new Date(),
): "adult" | "pediatric" | null {
  // Date-only, parsed as UTC calendar parts so a local timezone can't
  // shift the birthday across midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth.trim());
  if (!m) return fallback;
  const [, y, mo, d] = m;
  const birthYear = Number(y);
  const birthMonth = Number(mo);
  const birthDay = Number(d);
  if (!birthYear || !birthMonth || !birthDay) return fallback;

  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const nowDay = now.getUTCDate();

  let age = nowYear - birthYear;
  // Not yet reached this year's birthday → one year younger.
  if (nowMonth < birthMonth || (nowMonth === birthMonth && nowDay < birthDay)) {
    age -= 1;
  }
  return age < 18 ? "pediatric" : "adult";
}

async function loadInvite(
  orgId: string,
  inviteId: string,
): Promise<InviteContext | null | "unavailable"> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = (await supabase
      .from("fitter_invites")
      .select("patient_id, status, expires_at, channel")
      .eq("id", inviteId)
      .limit(1)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    if (error) return "unavailable";
    if (!data) return null;

    // The patient's own chart carries the branch and the payer the
    // formulary is scoped by. Best-effort: an unattached prospect simply
    // resolves both to null.
    let locationId: string | null = null;
    let payerProfileId: string | null = null;
    let chartPopulation: "adult" | "pediatric" | null = null;
    const patientId = (data.patient_id as string | null) ?? null;
    if (patientId) {
      const { data: patient } = (await supabase
        .from("patients")
        .select("location_id, date_of_birth")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      locationId = (patient?.location_id as string | null) ?? null;
      // CALENDAR comparison, not elapsed-days / 365.25. The average-year
      // divisor is short of a real 18 years by however many leap days
      // fell inside them, so a patient on their exact 18th birthday
      // computed to 17.9986 and was classified PEDIATRIC for the day —
      // which now decides the plausibility window, the service-line
      // filter, and what the fit request tells staff. "Has their 18th
      // birthday passed" is the actual question, so ask it directly.
      chartPopulation = classifyPopulationFromDob(
        String(patient?.date_of_birth ?? ""),
        chartPopulation,
      );

      // insurance_coverages stores a free-text `payer_name`, not a
      // payer_profiles id, so the payer axis has to be resolved by name.
      // EXACT (case-insensitive) equality only: a fuzzy match here would
      // silently apply another payer's formulary rules to a patient, which
      // is worse than not applying any. A miss leaves this null, and
      // `ruleApplies` then correctly declines to fire payer-scoped rules
      // rather than guessing.
      const { data: coverage } = (await supabase
        .from("insurance_coverages")
        .select("payer_name")
        .eq("patient_id", patientId)
        .eq("rank", "primary")
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      const payerName = (coverage?.payer_name as string | null) ?? null;
      if (payerName && payerName.trim()) {
        // `ilike` treats % and _ as wildcards, and payer_name is free
        // text — escape them so this stays the exact (case-insensitive)
        // equality the comment above promises, never a pattern match.
        const escaped = payerName.trim().replace(/([\\%_])/g, "\\$1");
        // payer_profiles is reference data with a NULLABLE org_id (NULL =
        // platform row, non-NULL = a tenant's private payer), reached via
        // .raw() like the mask catalog — so the tenant boundary has to be
        // this explicit filter. Without it a name that matches ANOTHER
        // tenant's private payer resolves to that foreign id, mis-scopes
        // the formulary rules, and is persisted as cross-tenant clinical
        // provenance. A tenant's own row outranks a platform row on a
        // name collision, mirroring loadSafetyScreen.
        const { data: profile } = (await supabase
          .raw()
          .schema("resupply")
          .from("payer_profiles")
          .select("id")
          .or(`org_id.is.null,org_id.eq.${orgId}`)
          .ilike("display_name", escaped)
          .order("org_id", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()) as { data: Record<string, unknown> | null };
        payerProfileId = (profile?.id as string | null) ?? null;
      }
    }

    return {
      patientId,
      locationId,
      payerProfileId,
      status: String(data.status ?? "sent"),
      expiresAt: (data.expires_at as string | null) ?? null,
      channel: (data.channel as string | null) ?? null,
      chartPopulation,
    };
  } catch {
    return "unavailable";
  }
}

interface PersistInput {
  orgId: string;
  inviteId: string;
  /** From the invite, when staff raised it against an existing chart. */
  patientId: string | null;
  locationId: string | null;
  /** The payer scope the formulary rules ran under — provenance the
   *  report needs to say which payer's rules produced this result. */
  payerProfileId: string | null;
  entryPoint: "remote_link" | "in_office" | "kiosk_qr" | "refit_campaign";
  measurements: FitMeasurements;
  /** The legacy questionnaire answers as the client sent them, kept so
   *  the invite's own `questionnaire_answers` column keeps its shape. */
  answers: unknown;
  profile: ReturnType<typeof buildProfile>;
  scan: ScanSignals;
  assessment: FitAssessment;
  safety: {
    screenVersion: string;
    attestedAt: string | null;
    responses: SafetyResponse[];
    snapshot: unknown;
  } | null;
  calibrationMethod: string | null;
}

/**
 * Write the fit session, its safety answers, and the opening provenance
 * event. Returns the session id, or null when the write failed — the
 * caller treats that as "the fitting still happened, we just could not
 * record it", which is strictly better than failing the patient's flow.
 */
async function persistSession(input: PersistInput): Promise<string | null> {
  try {
    const supabase = getOrgScopedClient(input.orgId);
    const { data, error } = await supabase
      .from("fit_sessions")
      .insert({
        fitter_invite_id: input.inviteId,
        // Carry the invite's chart link onto the session. Without this the
        // RT review queue shows "no patient" and the clinical PDF prints
        // "Not attached to a chart" for fittings that ARE chart-linked.
        patient_id: input.patientId,
        location_id: input.locationId,
        payer_profile_id: input.payerProfileId,
        entry_point: input.entryPoint,
        population: input.profile.population,
        service_line: input.profile.therapyMode,
        // `rescan_required` is reserved for outcomes a better photo can
        // actually fix. A contraindicated or out-of-range fitting needs a
        // clinician's decision, not a retake — mapping those to
        // rescan_required put them in the wrong worklist bucket.
        status:
          input.assessment.outcome === "high_confidence"
            ? "recommended"
            : input.assessment.outcome === "low_confidence"
              ? "rescan_required"
              : "awaiting_review",
        measurements: input.measurements,
        calibration_method: input.calibrationMethod,
        frame_count: input.scan.frameCount,
        scan_quality: input.scan.quality,
        scan_quality_grade:
          input.scan.band === "high"
            ? "good"
            : input.scan.band === "moderate"
              ? "marginal"
              : "poor",
        measurement_agreement: input.scan.agreement,
        measurement_confidence: input.scan.measurementConfidence,
        measurement_confidence_band: input.scan.band,
        profile_answers: input.profile,
        profile_version: input.profile.version,
        safety_screen_version: input.safety?.screenVersion ?? null,
        safety_flags: input.assessment.safetyFlags,
        safety_attested_at: input.safety?.attestedAt ?? null,
        safety_snapshot: input.safety?.snapshot ?? null,
        primary_recommendation: input.assessment.primary,
        // Dual-write the STRUCTURED recommendation alongside the JSON blob.
        //
        // Without these the loop never closes: `classifyDecision` in the
        // outcome report bails on a null primary before it ever looks at
        // the clinician's decision, so every fitting read as "undecided"
        // and the acceptance rate was permanently null — even though the
        // RT override route has always written override_mask_model_id.
        // The JSON carries the same ids, but a jsonb blob can't be joined,
        // filtered or FK-checked, which is why 0483 declared the columns.
        //
        // Null on a contraindicated / low-confidence / out-of-range
        // outcome, where there is deliberately no primary to record.
        //
        // ALSO null on the degraded path: the static fallback catalog's
        // ids are slugs ("resmed-airfit-f20"), not uuids, and these are
        // uuid FK columns — writing them made Postgres reject the entire
        // insert with 22P02, silently losing the clinical record of every
        // degraded fitting. The JSON blob above still carries the ids.
        primary_mask_model_id: input.assessment.provenance.degraded
          ? null
          : (input.assessment.primary?.maskId ?? null),
        primary_cushion_variant_id: input.assessment.provenance.degraded
          ? null
          : (input.assessment.primary?.cushion?.variantId ?? null),
        primary_frame_variant_id: input.assessment.provenance.degraded
          ? null
          : (input.assessment.primary?.frame?.variantId ?? null),
        alternatives: input.assessment.alternatives,
        excluded: input.assessment.excluded,
        recommendation_confidence: input.assessment.recommendationConfidence,
        outcome: input.assessment.outcome,
        rules_engine_version: RULES_ENGINE_VERSION,
        formulary_id: input.assessment.provenance.formularyId,
        formulary_version: input.assessment.provenance.formularyVersion,
        formulary_name: input.assessment.provenance.formularyName,
        formulary_rules_matched:
          input.assessment.provenance.formularyRulesMatched,
        // What the formulary HID (migration 0517). Distinct from the
        // matched-rule map above: an excluded mask never reaches scoring,
        // and a rule id alone doesn't say whether its effect demoted or
        // hid. Staff-only — redacted from the patient copy of the report.
        formulary_excluded_slugs:
          input.assessment.provenance.formularyExcludedSlugs,
        catalog_snapshot_version:
          input.assessment.provenance.catalogSnapshotVersion,
        degraded: input.assessment.provenance.degraded,
        // Every candidate's best size missed a gated dimension (0537).
        // No longer a gate — the engine recommends the closest size and
        // caps it at moderate — but still recorded, because one
        // unconfirmed winner and a catalog that could not size this
        // patient at all look identical afterwards if only per-candidate
        // `inBand` flags survive. A run of these is a band-calibration
        // problem, and this is what makes it visible as one.
        outside_validated_range:
          input.assessment.provenance.outsideValidatedRange,
        // A high-confidence fitting normally skips the review queue —
        // but NEVER on the degraded path: the static fallback catalog
        // ships zero mask contraindications (catalog-store.ts
        // staticCatalogAsMasks), so Tier-1 factor exclusions
        // (mouth-breathing, dentures, skin breakdown, …) were not
        // applied to this recommendation. Magnets still fail closed,
        // but a fitting produced without the full exclusion data must
        // be seen by a human before anyone acts on it.
        review_status:
          input.assessment.outcome === "high_confidence" &&
          !input.assessment.provenance.degraded
            ? "not_required"
            : "pending_review",
      })
      .select("id")
      .single();

    if (error || !data) {
      // The write path is best-effort, but a silent failure here loses
      // the clinical record with no trace at all. Message only — never
      // the row being inserted, which carries PHI.
      logger.warn(
        { message: error?.message ?? "no row returned" },
        "fit session persistence failed; the assessment was still returned",
      );
      return null;
    }
    const sessionId = String((data as { id: string }).id);

    if (input.safety && input.safety.responses.length > 0) {
      // The screen declares each question's subject — record THAT, not a
      // guess from the key's spelling. Tenant-authored screens are free to
      // use any question key (`bed_partner_pacemaker`), and the exclusion
      // logic already honors the declared subject/riskFlag; deriving the
      // stored subject from a `household_` prefix mislabelled every
      // non-prefixed household question as the patient's own implant on
      // the signed fit report. The prefix heuristic survives only as the
      // fallback for a response whose key isn't in the snapshot.
      const snapshot = input.safety.snapshot as {
        questions?: Array<{ questionKey: string; subject: string }>;
      } | null;
      const subjectByKey = new Map(
        (snapshot?.questions ?? []).map((q) => [q.questionKey, q.subject]),
      );
      const { error: safetyErr } = await supabase
        .from("fit_session_safety_responses")
        .insert(
          input.safety.responses.map((r) => ({
            fit_session_id: sessionId,
            screen_version: input.safety!.screenVersion,
            question_key: r.questionKey,
            subject:
              subjectByKey.get(r.questionKey) ??
              (r.questionKey.startsWith("household_")
                ? "household"
                : "patient"),
            answer: r.answer,
          })),
        );
      // PostgREST failures resolve as `{ error }` without throwing, so the
      // surrounding try/catch never sees them. Message only — the rows
      // carry safety answers, which are PHI.
      if (safetyErr) {
        logger.warn(
          { fitSessionId: sessionId, message: safetyErr.message },
          "fit session safety responses persistence failed",
        );
      }
    }

    // Provenance trail. `detail` carries codes and counts only — never
    // free-text PHI.
    const { error: eventsErr } = await supabase
      .from("fit_session_events")
      .insert([
        {
          fit_session_id: sessionId,
          event_type: "session.started",
          actor_kind: "patient",
          detail: { entryPoint: input.entryPoint },
        },
        {
          fit_session_id: sessionId,
          event_type: "recommendation.generated",
          actor_kind: "system",
          detail: {
            outcome: input.assessment.outcome,
            candidateCount: input.assessment.alternatives.length,
            excludedCount: input.assessment.excluded.length,
            rulesEngineVersion: RULES_ENGINE_VERSION,
            degraded: input.assessment.provenance.degraded,
          },
        },
      ]);
    if (eventsErr) {
      logger.warn(
        { fitSessionId: sessionId, message: eventsErr.message },
        "fit session provenance events persistence failed",
      );
    }

    // Record the completed fitting on the invite — the row the STAFF
    // worklist reads — and link it to this session so the worklist can
    // deep-link the clinical record.
    //
    // This used to write `fit_session_id` alone, on the stated assumption
    // that "the legacy columns are still written by
    // /shop/fitter-invite/complete". That assumption was false for
    // precisely the fittings that matter most: the page only transmits
    // when it has a mask to name, so every contraindicated /
    // out-of-validated-range / everything-excluded fitting left its
    // invite stranded at "opened" with no measurements and no completion
    // time, invisible on every invite surface, while the fit_sessions row
    // right here held the whole story.
    //
    // The engine deciding is what finishes a fitting, and the server
    // knows it at this line — so it is recorded here rather than hoped
    // for from the browser. The helper claims the completion atomically,
    // so the page's own (still-firing) transmission cannot double-meter.
    await completeInviteFromFitting({
      orgId: input.orgId,
      inviteId: input.inviteId,
      measurements: input.measurements,
      // The legacy column keeps the legacy shape — the structured v2
      // profile is already on the session as `profile_answers`.
      answers: input.answers ?? input.profile,
      primary: input.assessment.primary
        ? {
            maskId: input.assessment.primary.maskSlug,
            name: input.assessment.primary.name,
            type: toLegacyMaskType(input.assessment.primary.interfaceType),
          }
        : null,
      ranked: [
        ...(input.assessment.primary ? [input.assessment.primary] : []),
        ...input.assessment.alternatives,
      ].map((c) => ({
        maskId: c.maskSlug,
        name: c.name,
        type: toLegacyMaskType(c.interfaceType),
        confidence: c.confidence,
      })),
      fitSessionId: sessionId,
      source: "fitter.assess.complete",
    });

    return sessionId;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "fit session persistence failed; the assessment was still returned",
    );
    return null;
  }
}

export default router;
