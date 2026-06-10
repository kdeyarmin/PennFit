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

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyFitterInviteToken } from "../../lib/fitter-invite-token";

type FitterInvitesUpdate =
  Database["resupply"]["Tables"]["fitter_invites"]["Update"];

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

  const supabase = getSupabaseServiceRoleClient();
  const { data: invite, error } = await supabase
    .schema("resupply")
    .from("fitter_invites")
    .select("id, status, recipient_email, recipient_name, expires_at")
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
        .schema("resupply")
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
      .schema("resupply")
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

  res.json({
    valid: true,
    email: invite.recipient_email,
    name: invite.recipient_name,
  });
});

// ---- completion payload validation -------------------------------

const measurementsSchema = z
  .object({
    noseWidth: z.number().finite(),
    noseHeight: z.number().finite(),
    noseToChin: z.number().finite(),
    mouthWidth: z.number().finite(),
    faceWidthAtCheekbones: z.number().finite(),
    calibrationMethod: z.string().max(64).optional(),
  })
  .passthrough();

const answersSchema = z.record(z.string(), z.unknown());

const maskType = z.enum(["fullFace", "nasal", "nasalPillow", "hybrid"]);

const recommendationSchema = z.object({
  maskId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  type: maskType,
  // Ranked top-N (the cards the patient saw), stored verbatim for
  // staff follow-up. Bounded so a hostile client can't bloat the row.
  top: z
    .array(
      z
        .object({
          maskId: z.string().max(200),
          name: z.string().max(300),
          type: maskType,
          confidence: z.number().finite().optional(),
        })
        .passthrough(),
    )
    .max(10)
    .optional(),
});

const completeBody = z
  .object({
    t: z.string().min(1),
    measurements: measurementsSchema,
    answers: answersSchema,
    recommendation: recommendationSchema,
  })
  .strict();

/** Find the single patient that owns this email/phone, if any. More
 *  than one match is treated as "no match" — we never auto-cross-link
 *  PHI on an ambiguous identity (mirrors me-documents findPatientByEmail). */
async function findUniquePatient(
  email: string | null,
  phone: string | null,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  if (email) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("email", email)
      .limit(2);
    if (error) throw error;
    if (data && data.length === 1) return data[0]!.id;
    if (data && data.length > 1) return null;
  }
  if (phone) {
    const { data, error } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("phone_e164", phone)
      .limit(2);
    if (error) throw error;
    if (data && data.length === 1) return data[0]!.id;
  }
  return null;
}

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
    const verified = verifyFitterInviteToken(parsed.data.t);
    if (!verified.valid) {
      res.status(401).json({ error: "invalid_token", reason: verified.reason });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: invite, error } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .select(
        "id, status, patient_id, recipient_email, recipient_phone_e164, opened_at, expires_at",
      )
      .eq("id", verified.inviteId)
      .limit(1)
      .maybeSingle();
    // Fail soft on a DB hiccup — the patient already sees their result;
    // losing the best-effort transmission must not 500 them.
    if (error) {
      logger.warn(
        { err: error, inviteId: verified.inviteId },
        "fitter-invite: completion lookup failed",
      );
      res.json({ ok: true, matched: false });
      return;
    }
    if (!invite) {
      res.status(404).json({ error: "invite_not_found" });
      return;
    }
    if (invite.status === "revoked") {
      res.status(409).json({ error: "revoked" });
      return;
    }

    const rec = parsed.data.recommendation;
    const nowIso = new Date().toISOString();

    // Auto-attach: only when not already linked (a manual attach, or a
    // re-submit, must not be clobbered).
    let patientId = invite.patient_id;
    let autoMatched = false;
    if (!patientId) {
      try {
        const match = await findUniquePatient(
          invite.recipient_email,
          invite.recipient_phone_e164,
        );
        if (match) {
          patientId = match;
          autoMatched = true;
        }
      } catch (matchErr) {
        // Best-effort — a lookup failure must not lose the fitting.
        logger.warn(
          { err: matchErr, inviteId: invite.id },
          "fitter-invite: auto-match lookup failed",
        );
      }
    }

    const update: FitterInvitesUpdate = {
      // Don't downgrade an already-attached fitting on a re-submit —
      // resolve allows reopening an attached invite, and rewriting it
      // to "completed" would orphan patient_id/attached_at and pull it
      // back into the holding worklist. Keep terminal states sticky.
      status: invite.status === "attached" ? "attached" : "completed",
      completed_at: nowIso,
      // Preserve the true first-open timestamp; only backfill it when
      // resolve was skipped (still in 'sent').
      ...(invite.opened_at ? {} : { opened_at: nowIso }),
      // Zod's passthrough/record widen these to `unknown`-valued shapes
      // that don't structurally satisfy the generated `Json` type even
      // though they are valid JSON at runtime. Cast at the storage edge.
      measurements: parsed.data
        .measurements as unknown as Database["resupply"]["Tables"]["fitter_invites"]["Row"]["measurements"],
      questionnaire_answers: parsed.data
        .answers as unknown as Database["resupply"]["Tables"]["fitter_invites"]["Row"]["questionnaire_answers"],
      recommended_mask_id: rec.maskId,
      recommended_mask_name: rec.name,
      recommended_mask_type: rec.type,
      recommendations: (rec.top ?? [
        rec,
      ]) as unknown as Database["resupply"]["Tables"]["fitter_invites"]["Row"]["recommendations"],
      updated_at: nowIso,
    };
    if (patientId && !invite.patient_id) {
      update.patient_id = patientId;
      update.auto_matched = autoMatched;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("fitter_invites")
      .update(update)
      .eq("id", invite.id);
    // Best-effort: a transient write failure must not 500 the patient.
    if (updErr) {
      logger.warn(
        { err: updErr, inviteId: invite.id },
        "fitter-invite: completion write failed",
      );
      res.json({ ok: true, matched: false });
      return;
    }

    // Counts/flags only — never the measurements or recipient PHI.
    req.log?.info?.(
      { matched: Boolean(patientId), autoMatched },
      "shop/fitter-invite: completion recorded",
    );

    res.json({ ok: true, matched: Boolean(patientId) });
  },
);

export default router;
