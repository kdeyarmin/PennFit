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
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyFitterInviteToken } from "../../lib/fitter-invite-token.js";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { loadFittingContext } from "../../lib/fitting/catalog-store.js";
import { assess } from "../../lib/fitting/index.js";
import { buildProfile } from "../../lib/fitting/profile.js";
import { RULES_ENGINE_VERSION } from "../../lib/fitting/versions.js";
import type {
  FitAssessment,
  FitMeasurements,
  SafetyResponse,
  ScanSignals,
} from "../../lib/fitting/types.js";

const router: IRouter = Router();

// Server-side plausibility window, mirroring the client and the legacy
// route. Generous enough for ~99% of adult faces; a value outside it is a
// measurement failure, not a small patient, and now feeds the
// `outside_validated_range` exception state rather than a flat 400.
const ADULT_BOUNDS = {
  noseWidth: [20, 60],
  noseHeight: [25, 70],
  noseToChin: [40, 90],
  mouthWidth: [30, 80],
  faceWidthAtCheekbones: [110, 180],
} as const;

const PEDIATRIC_BOUNDS = {
  noseWidth: [12, 45],
  noseHeight: [15, 55],
  noseToChin: [25, 70],
  mouthWidth: [18, 60],
  faceWidthAtCheekbones: [80, 150],
} as const;

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
    scan: scanSchema.optional(),
    safety: safetySchema.optional(),
    entryPoint: z.enum(["remote_link", "in_office", "kiosk_qr"]).optional(),
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

router.post("/fit/assess", async (req, res) => {
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
  const profile = buildProfile(body.answers ?? null, body.profile ?? null);
  const bounds =
    profile.population === "pediatric" ? PEDIATRIC_BOUNDS : ADULT_BOUNDS;

  const measurements: FitMeasurements = {
    noseWidth: body.measurements.noseWidth,
    noseHeight: body.measurements.noseHeight,
    noseToChin: body.measurements.noseToChin,
    mouthWidth: body.measurements.mouthWidth,
    faceWidthAtCheekbones: body.measurements.faceWidthAtCheekbones,
  };

  // Grossly impossible numbers are rejected outright — they indicate a
  // broken or hostile client, not a patient. Values that are merely
  // outside the sizing window fall through to the engine, which returns
  // `outside_validated_range` and says so plainly.
  for (const [field, [min, max]] of Object.entries(bounds)) {
    const value = measurements[field as keyof FitMeasurements];
    if (value <= 0 || value > max * 3) {
      res.status(400).json({
        error: "Invalid input",
        details: [
          `measurements.${field}: must be a number between ${min} and ${max} mm`,
        ],
      });
      return;
    }
  }

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

  const [enabled, gating, magnets] = await Promise.all([
    isFeatureEnabled("fitter.clinical_assessment", orgId).catch(() => false),
    isFeatureEnabled("fitter.confidence_gating", orgId).catch(() => false),
    isFeatureEnabled("fitter.magnet_screening", orgId).catch(() => false),
  ]);
  if (!enabled) {
    res.status(404).json({
      error:
        "The clinical fitting assessment is not enabled for this provider.",
    });
    return;
  }

  const context = await loadFittingContext(orgId);

  const safetyResponses: SafetyResponse[] = (body.safety?.responses ?? []).map(
    (r) => ({ questionKey: r.questionKey, answer: r.answer }),
  );

  const assessment = assess({
    measurements,
    profile,
    scan: body.scan ?? NEUTRAL_SCAN,
    catalog: context.catalog,
    formulary: context.formulary,
    context: {
      locationId: null,
      payerProfileId: null,
      contractRef: null,
      population: profile.population,
      therapyMode: profile.therapyMode,
      asOf: new Date().toISOString().slice(0, 10),
    },
    safetyScreen: context.safetyScreen,
    safetyResponses,
    availability: context.availability,
    // Empirical outcome adjustments are loaded per tenant by the admin
    // signal route today; wiring them into the live path is the next
    // increment of the closed loop.
    fitAdjustments: {},
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
    entryPoint: body.entryPoint ?? "remote_link",
    measurements,
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

  res.json({ ...assessment, fitSessionId: sessionId });
});

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

  const context = await loadFittingContext(orgId);
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    total: context.catalog.length,
    degraded: context.degraded,
    formulary: {
      name: context.formulary.name,
      version: context.formulary.version,
    },
    masks: context.catalog.map((m) => ({
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
        .map((v) => ({ code: v.sizeCode, label: v.sizeLabel })),
    })),
  });
});

interface PersistInput {
  orgId: string;
  inviteId: string;
  entryPoint: "remote_link" | "in_office" | "kiosk_qr";
  measurements: FitMeasurements;
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
        entry_point: input.entryPoint,
        population: input.profile.population,
        service_line: input.profile.therapyMode,
        status:
          input.assessment.outcome === "high_confidence"
            ? "recommended"
            : input.assessment.outcome === "moderate_confidence"
              ? "awaiting_review"
              : "rescan_required",
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
        alternatives: input.assessment.alternatives,
        excluded: input.assessment.excluded,
        recommendation_confidence: input.assessment.recommendationConfidence,
        outcome: input.assessment.outcome,
        rules_engine_version: RULES_ENGINE_VERSION,
        formulary_id: input.assessment.provenance.formularyId,
        formulary_version: input.assessment.provenance.formularyVersion,
        formulary_rules_matched:
          input.assessment.provenance.formularyRulesMatched,
        catalog_snapshot_version:
          input.assessment.provenance.catalogSnapshotVersion,
        degraded: input.assessment.provenance.degraded,
        review_status:
          input.assessment.outcome === "high_confidence"
            ? "not_required"
            : "pending_review",
      })
      .select("id")
      .single();

    if (error || !data) return null;
    const sessionId = String((data as { id: string }).id);

    if (input.safety && input.safety.responses.length > 0) {
      await supabase.from("fit_session_safety_responses").insert(
        input.safety.responses.map((r) => ({
          fit_session_id: sessionId,
          screen_version: input.safety!.screenVersion,
          question_key: r.questionKey,
          // The screen declares each question's subject; we record what the
          // patient answered against and let the report render the split.
          subject: r.questionKey.startsWith("household_")
            ? "household"
            : "patient",
          answer: r.answer,
        })),
      );
    }

    // Provenance trail. `detail` carries codes and counts only — never
    // free-text PHI.
    await supabase.from("fit_session_events").insert([
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

    // Link the invite back to the session so the existing worklist can
    // deep-link it. Best-effort; the legacy columns are still written by
    // /shop/fitter-invite/complete.
    await supabase
      .from("fitter_invites")
      .update({ fit_session_id: sessionId })
      .eq("id", input.inviteId);

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
