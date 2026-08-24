// Public endpoints for staff-initiated AI mask-fitter invitations.
//
//   GET  /shop/fitter-invite/resolve?t=<token>
//        Verify the signed link, mark the invite "opened", and return
//        the prefill (email + name) so the storefront can drop the
//        patient straight into the fitter without re-asking for an
//        email.
//
//   POST /shop/fitter-invite/complete
//        Body: { t, measurements, answers, recommendation }. Verify
//        the token, store the fitting results on the invite row, and
//        auto-attach to a patient chart when the recipient's email
//        (then phone) matches exactly one patient on file.
//
// PHI note: per the codebase invariant, only NUMERIC facial
// measurements + questionnaire answers travel here — no images. The
// recommendation is a catalog reference. The request body is never
// logged (only counts/flags).

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { getFeatureFlagState, isFeatureEnabled } from "../../lib/feature-flags";
import { completeInviteFromFitting } from "../../lib/fitting/complete-invite";
import {
  type PlausibilityField,
  UNION_PLAUSIBILITY_BOUNDS,
} from "../../lib/fitting/index";
import { logger } from "../../lib/logger";
import { verifyFitterInviteToken } from "../../lib/fitter-invite-token";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org";

const router: IRouter = Router();

const resolveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
const completeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Statuses from which a patient can still (re)start the fitter.
const OPENABLE = new Set(["sent", "opened", "completed", "attached"]);

router.get("/shop/fitter-invite/resolve", resolveLimiter, async (req, res) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  const verified = verifyFitterInviteToken(token);
  if (!verified.valid) {
    res.status(200).json({ valid: false, reason: verified.reason });
    return;
  }

  // Resolve the tenant FROM the invite the token references (the link
  // carries no host/session), so a tenant-B invite lands in tenant B.
  const orgId = await resolveOrgIdForSignedRecord(
    "fitter_invites",
    verified.inviteId,
  );
  if (!orgId) {
    res.status(503).json({ error: "tenant_unavailable" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const { data: invite, error } = await supabase
    .from("fitter_invites")
    .select("id, status, channel, recipient_email, recipient_name, expires_at")
    .eq("id", verified.inviteId)
    .limit(1)
    .maybeSingle();
  // Fail soft — a DB hiccup must not 500 the patient. Surface a
  // friendly "couldn't open" dead-end instead.
  if (error) {
    logger.warn(
      { err: error, inviteId: verified.inviteId },
      "fitter-invite: resolve lookup failed",
    );
    res.status(200).json({ valid: false, reason: "error" });
    return;
  }
  if (!invite) {
    res.status(200).json({ valid: false, reason: "not_found" });
    return;
  }
  if (invite.status === "revoked") {
    res.status(200).json({ valid: false, reason: "revoked" });
    return;
  }
  // Lazily mark a past-TTL invite expired (no sweep job needed).
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    if (invite.status !== "expired") {
      // Best-effort lazy stamp — the expired response is correct
      // regardless, and a DB hiccup must not 500 the patient.
      const { error: expireErr } = await supabase
        .from("fitter_invites")
        .update({ status: "expired", updated_at: new Date().toISOString() })
        .eq("id", invite.id);
      if (expireErr) {
        logger.warn(
          { err: expireErr, inviteId: invite.id },
          "fitter-invite: expired stamp failed",
        );
      }
    }
    res.status(200).json({ valid: false, reason: "expired" });
    return;
  }
  if (!OPENABLE.has(invite.status)) {
    res.status(200).json({ valid: false, reason: "unavailable" });
    return;
  }

  // First open flips sent → opened (don't downgrade completed/attached).
  if (invite.status === "sent") {
    const nowIso = new Date().toISOString();
    // Best-effort — failing to record the open must not block the
    // patient from starting the fitter.
    const { error: openErr } = await supabase
      .from("fitter_invites")
      .update({ status: "opened", opened_at: nowIso, updated_at: nowIso })
      .eq("id", invite.id)
      .eq("status", "sent");
    if (openErr) {
      logger.warn(
        { err: openErr, inviteId: invite.id },
        "fitter-invite: opened stamp failed",
      );
    }
  }

  // Prefill is suppressed for an in-office invite (migration 0489).
  //
  // That QR is DISPLAYED on a staff screen in a semi-public space, which
  // is a different exposure from a link mailed to one person. Anyone who
  // photographs it can call this endpoint, and the create route resolves
  // the chart's email and name onto a patient-linked invite before it
  // ever looks at the channel — so echoing them back here would hand a
  // bystander another patient's identifying details.
  //
  // Nothing is lost by withholding them: the patient is standing at the
  // counter with staff who already know who they are, and the fields
  // stay on the row server-side so a later rescan can still reach them.
  const inOffice = invite.channel === "in_office";

  // Tell the SPA which questionnaire this tenant runs. The v2 Patient
  // Fit Profile is a per-tenant flag, and the questionnaire renders
  // BEFORE the /results page ever probes the clinical route — so this
  // resolve response (the one call that already knows the tenant) is
  // where the flag has to travel. Fail-soft to the legacy questionnaire.
  //
  // `fitter.multiframe_capture` travels the same way for the same reason:
  // /capture renders long before /results, and it is the page that has to
  // know whether to run the guided multi-angle scan or the single-frame
  // capture. Fail-soft to single-frame.
  //
  // `fitter.lead_capture_only` travels the same way and for the same
  // reason — /results and /order both need it — but it resolves in the
  // OPPOSITE direction on failure. The other two fail soft to "off"
  // because the safe fallback there is the simpler experience; this one
  // decides whether a patient may file their own insurance order, so a
  // lookup that never reached the tenant's row must read as ON.
  // `isFeatureEnabled` absorbs every failure into its own fail-closed
  // posture (making a `.catch()` around it dead code), so this uses
  // `getFeatureFlagState`, which reports whether the boolean is real.
  const [fitProfileV2, multiframeCapture, leadCaptureState] = await Promise.all(
    [
      isFeatureEnabled("fitter.fit_profile_v2", orgId).catch(() => false),
      isFeatureEnabled("fitter.multiframe_capture", orgId).catch(() => false),
      getFeatureFlagState("fitter.lead_capture_only", orgId),
    ],
  );
  const leadCaptureOnly = leadCaptureState.enabled || leadCaptureState.degraded;

  res.json({
    valid: true,
    email: inOffice ? null : invite.recipient_email,
    name: inOffice ? null : invite.recipient_name,
    fitProfileV2,
    multiframeCapture,
    leadCaptureOnly,
  });
});

// ---- completion payload validation -------------------------------
//
// This is the third ingest path for fitting data (after /api/recommend
// and /api/fit/assess), and what it accepts is written verbatim into
// jsonb columns that staff later view — so it enforces the same two
// guards its siblings have: numeric plausibility bounds on the
// measurements, and the belt-and-braces encoded-media check ("no images
// in the backend" is a hard rule, and the header comment alone does not
// enforce it). Unknown keys are STRIPPED rather than rejected (plain
// z.object, no .passthrough()), so a newer client with extra fields
// degrades to "extras dropped" instead of silently losing the whole
// transmission — this endpoint is fire-and-forget on the client.

/**
 * Adult ∪ pediatric plausibility window (mm). This route cannot know the
 * patient's population, so it uses the union window — the same one the
 * client's /measure gate and the public /api/recommend route apply. It
 * is imported from lib/fitting/confidence.ts, not transcribed: this was
 * previously one of three hand-copied tables kept in sync by a comment.
 */
const boundedMm = (field: PlausibilityField) =>
  z
    .number()
    .finite()
    .min(UNION_PLAUSIBILITY_BOUNDS[field][0])
    .max(UNION_PLAUSIBILITY_BOUNDS[field][1]);

const measurementsSchema = z.object({
  noseWidth: boundedMm("noseWidth"),
  noseHeight: boundedMm("noseHeight"),
  noseToChin: boundedMm("noseToChin"),
  mouthWidth: boundedMm("mouthWidth"),
  faceWidthAtCheekbones: boundedMm("faceWidthAtCheekbones"),
  calibrationMethod: z.enum(["creditCard", "iris", "manual"]).optional(),
});

// The v1 questionnaire is 11 keys of booleans/enums. Bounded as a record
// (rather than enumerating the keys) so questionnaire evolution doesn't
// 400 an older server — but bounded hard: scalar values only, capped
// lengths and key count. A nested object or a long string is exactly
// where encoded media would hide.
const answersSchema = z
  .record(
    z.string().max(64),
    z.union([z.boolean(), z.number().finite(), z.string().max(200), z.null()]),
  )
  .refine((r) => Object.keys(r).length <= 40, {
    message: "too many answer keys",
  });

const maskType = z.enum(["fullFace", "nasal", "nasalPillow", "hybrid"]);

const recommendationSchema = z.object({
  maskId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  type: maskType,
  // Ranked top-N (the cards the patient saw), stored for staff
  // follow-up. Bounded so a hostile client can't bloat the row; unknown
  // keys on each entry are stripped, not stored.
  top: z
    .array(
      z.object({
        maskId: z.string().max(200),
        name: z.string().max(300),
        type: maskType,
        confidence: z.number().finite().optional(),
      }),
    )
    .max(10)
    .optional(),
});

/**
 * Belt-and-braces guard against encoded media, mirroring
 * routes/storefront/fit-assess.ts and recommend.ts. Runs against the RAW
 * request body (before Zod strips unknown keys), so media smuggled under
 * a key the schema would drop is still rejected loudly instead of
 * silently discarded.
 */
function looksLikeEncodedMedia(body: unknown): boolean {
  const s = JSON.stringify(body ?? {});
  return (
    /data:[a-z]+\/[a-z]+;base64,/i.test(s) || /[A-Za-z0-9+/]{1000,}/.test(s)
  );
}

const completeBody = z
  .object({
    t: z.string().min(1),
    measurements: measurementsSchema,
    answers: answersSchema,
    // NULLABLE, and that is the point.
    //
    // A fitting that named no mask — contraindicated, outside the
    // validated range, every candidate excluded by the tenant formulary —
    // is still a finished fitting, and the one staff most need to see.
    // While this field was required, the page had nothing valid to send
    // for those and so sent NOTHING: the invite sat at "opened" forever
    // and the fitting existed on no invite surface at all.
    recommendation: recommendationSchema.nullish(),
  })
  .strict();

router.post(
  "/shop/fitter-invite/complete",
  completeLimiter,
  async (req, res) => {
    const parsed = completeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (looksLikeEncodedMedia(req.body)) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "",
            message:
              "Request body contains binary or encoded media, which this endpoint never accepts — only numeric measurements, scalar questionnaire answers, and catalog references.",
          },
        ],
      });
      return;
    }
    const verified = verifyFitterInviteToken(parsed.data.t);
    if (!verified.valid) {
      res.status(401).json({ error: "invalid_token", reason: verified.reason });
      return;
    }

    // Resolve the tenant FROM the token-referenced invite (see GET above).
    const orgId = await resolveOrgIdForSignedRecord(
      "fitter_invites",
      verified.inviteId,
    );
    if (!orgId) {
      res.status(503).json({ error: "tenant_unavailable" });
      return;
    }

    // The write itself — including auto-attach and the atomic
    // exactly-once billing claim — lives in the shared helper, because
    // /api/fit/assess records the same completion server-side and the two
    // must not double-meter one fitting.
    const rec = parsed.data.recommendation ?? null;
    const outcome = await completeInviteFromFitting({
      orgId,
      inviteId: verified.inviteId,
      measurements: parsed.data.measurements,
      answers: parsed.data.answers,
      primary: rec
        ? { maskId: rec.maskId, name: rec.name, type: rec.type }
        : null,
      // A named mask always ranks at least itself: an explicitly empty
      // `top` must not read as "nothing to record" and leave the column
      // stale (the helper skips an empty list by design).
      ranked: rec ? (rec.top?.length ? rec.top : [rec]) : [],
      source: "fitter.invite.complete",
    });

    switch (outcome.kind) {
      case "not_found":
        res.status(404).json({ error: "invite_not_found" });
        return;
      case "revoked":
        res.status(409).json({ error: "revoked" });
        return;
      case "expired":
        res.status(409).json({ error: "expired" });
        return;
      case "unrecorded":
        // Fail soft — the patient already sees their result; losing the
        // best-effort transmission must not 500 them.
        res.json({ ok: true, matched: false });
        return;
    }

    // Counts/flags only — never the measurements or recipient PHI.
    req.log?.info?.(
      { matched: outcome.matched, recommended: rec !== null },
      "shop/fitter-invite: completion recorded",
    );

    res.json({ ok: true, matched: outcome.matched });
  },
);

export default router;
