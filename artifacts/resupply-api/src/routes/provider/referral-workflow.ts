// The clinical half of the provider referral portal: getting the patient
// fitted, approving a mask, signing the order, and routing it to the DME.
//
//   POST /api/provider/referrals/:id/fitting  — put the patient in front
//                                               of the fitter
//   GET  /api/provider/referrals/:id/fitting  — the recommendation, once
//                                               the patient has finished
//   POST /api/provider/referrals/:id/approve  — approve a mask + size
//   POST /api/provider/referrals/:id/signature — raise the order for signing
//   POST /api/provider/referrals/:id/submit   — send it to the DME
//
// THREE ENTRY POINTS, ONE MECHANISM
// ---------------------------------
// The spec asks for remote, in-office, and kiosk/QR fittings. All three
// are the same signed `fitter_invites` row and the same link; what differs
// is only how the link reaches the patient:
//
//   remote_link  emailed or texted to the patient, they scan at home
//   in_office    not delivered at all — the provider gets the URL back
//                and opens it on a device in the room ("Scan Now")
//   kiosk_qr     not delivered either — the URL is rendered as a QR code
//                for the patient to scan with their own phone
//
// Keeping one mechanism matters: a fitting is a fitting, and the session
// it produces has to be identical whichever door the patient came
// through, or the clinical record stops being comparable. The entry point
// is recorded on both the referral and the fit session so outcomes can
// later be compared BY channel — which is the honest way to find out
// whether unsupervised remote scans really are as good as in-office ones,
// rather than assuming it.
//
// SIGNATURE reuses the existing provider e-signature queue (0297) with the
// subject vocabulary widened to 'referral' (migration 0487). Not a second
// signing path: same capture, same ESIGN consent, same signature-log PDF,
// one audit trail.
//
// PHI: same posture as the rest of the tree — ids, codes, and counts in
// logs and in `referral_events.detail`; never a name, never free text.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  FITTER_INVITE_TTL_MS,
  signFitterInviteToken,
} from "../../lib/fitter-invite-token";
import { resolveTenantBaseUrl } from "../../lib/tenant-branding";
import {
  requireProvider,
  requireProviderMfaEnrolled,
} from "../../middlewares/requireProvider";
import { providerPortalRateLimiter } from "./shared";
import {
  loadReferralForProvider,
  providerMayReferTo,
  recordReferralEvent,
} from "./referral-shared.js";

const router: IRouter = Router();

const uuid = z.string().trim().uuid();

const gate = [
  ...requireProvider,
  requireProviderMfaEnrolled,
  providerPortalRateLimiter,
];

const fittingBody = z
  .object({
    entryPoint: z.enum(["remote_link", "in_office", "kiosk_qr"]),
    /** Only consulted for `remote_link`. */
    channel: z.enum(["email", "sms"]).optional(),
  })
  .strict();

const approveBody = z
  .object({
    maskModelId: uuid,
    variantId: uuid.nullable().optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

// ── Fitting ──────────────────────────────────────────────────────────

router.post(
  "/api/provider/referrals/:id/fitting",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = fittingBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (found.row.status === "cancelled" || found.row.status === "declined") {
      res.status(409).json({
        error: "not_active",
        message: "This referral is closed.",
      });
      return;
    }

    const entryPoint = body.data.entryPoint;
    const channel = body.data.channel ?? "email";

    // A remote link has to have somewhere to go. In-office and kiosk hand
    // the URL back to the provider instead, so they need no contact detail
    // at all — which is exactly why they exist for a patient sitting in the
    // room with no email on file.
    if (entryPoint === "remote_link") {
      const hasEmail = Boolean(found.row.patient_email);
      const hasPhone = Boolean(found.row.patient_phone_e164);
      if (
        (channel === "email" && !hasEmail) ||
        (channel === "sms" && !hasPhone)
      ) {
        res.status(400).json({
          error: "no_contact",
          message:
            channel === "email"
              ? "This referral has no patient email. Add one, pick text message, or fit them in the office."
              : "This referral has no patient mobile number. Add one, pick email, or fit them in the office.",
        });
        return;
      }
    }

    const supabase = getOrgScopedClient(found.orgId);
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(
      Date.now() + FITTER_INVITE_TTL_MS,
    ).toISOString();

    try {
      const { data: invite, error: inviteErr } = (await supabase
        .from("fitter_invites")
        .insert({
          patient_id: found.row.patient_id ?? null,
          recipient_email: found.row.patient_email ?? null,
          recipient_phone_e164: found.row.patient_phone_e164 ?? null,
          recipient_name:
            `${found.row.patient_first_name} ${found.row.patient_last_name}`.trim(),
          channel,
          status: "sent",
          invited_by_email: account.emailLower,
          sent_at: nowIso,
          expires_at: expiresIso,
        })
        .select("id")
        .limit(1)
        .maybeSingle()) as {
        data: { id: string } | null;
        error: { message: string } | null;
      };
      if (inviteErr || !invite) {
        res.status(500).json({ error: "insert_failed" });
        return;
      }

      const token = signFitterInviteToken(invite.id);
      // A tenant with a verified custom domain gets a link on their own
      // brand; everyone else falls back to the platform host.
      const baseUrl =
        (await resolveTenantBaseUrl(found.orgId).catch(() => null)) ??
        "https://cmbreathe.com";
      // Carry the entry point through to the fitter. Without it
      // /api/fit/assess defaults every persisted session to
      // `remote_link`, which would systematically mislabel in-office and
      // kiosk fittings and quietly defeat the by-channel outcome
      // comparison this feature is explicitly built to enable.
      const link =
        `${baseUrl.replace(/\/$/, "")}/fitter-invite` +
        `?t=${encodeURIComponent(token)}` +
        `&entry=${encodeURIComponent(entryPoint)}`;

      await supabase
        .from("referrals")
        .update({
          fitter_invite_id: invite.id,
          entry_point: entryPoint,
          fitting_sent_at: nowIso,
          status:
            found.row.status === "draft"
              ? "awaiting_fitting"
              : found.row.status,
          updated_at: nowIso,
        })
        .eq("id", id.data);

      let delivered = false;
      let deliveryReason: string | null = null;
      if (entryPoint === "remote_link") {
        const result = await deliverFittingLink({
          orgId: found.orgId,
          channel,
          email: found.row.patient_email ?? null,
          phone: found.row.patient_phone_e164 ?? null,
          firstName: found.row.patient_first_name,
          link,
        });
        delivered = result.delivered;
        deliveryReason = result.reason;
      }

      await recordReferralEvent(found.orgId, id.data, "fitting.sent", {
        actorKind: "provider",
        actorEmail: account.emailLower,
        detail: { entryPoint, channel, delivered },
      });

      res.json({
        ok: true,
        entryPoint,
        // In-office and kiosk NEED the URL back — that is how the provider
        // opens it on a room device or renders the QR code. For a remote
        // link it is returned too, so staff can read it out when delivery
        // failed rather than being stuck.
        fittingUrl: link,
        delivered,
        deliveryReason,
        expiresAt: expiresIso,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "referral fitting invite failed",
      );
      res.status(500).json({ error: "insert_failed" });
    }
  },
);

/**
 * The recommendation, once the patient has finished.
 *
 * Reads the `fit_sessions` row the fitter wrote and hands back what the
 * provider needs to make a decision: the outcome band, the primary
 * recommendation with its size, the alternatives with their reasons, and
 * the exclusions. Deliberately NOT the raw measurements — a referring
 * physician approving a mask does not need the patient's facial
 * millimetres, and the fit report PDF exists for the cases that do.
 */
router.get("/api/provider/referrals/:id/fitting", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const id = uuid.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const found = await loadReferralForProvider(account.providerId, id.data);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const supabase = getOrgScopedClient(found.orgId);

  // The fitting may have completed since the referral row was last
  // touched, so resolve the session by invite rather than trusting the
  // cached `fit_session_id`.
  //
  // TWO FITTING PATHS, AND BOTH HAVE TO RESOLVE.
  // `fitter.clinical_assessment` is seeded OFF, so on most tenants today
  // the patient completes through the LEGACY /api/recommend flow, which
  // fills the invite's own recommendation columns and creates no
  // `fit_sessions` row at all. Reading only `fit_session_id` therefore
  // reported "pending" forever on the default configuration and the
  // provider could never reach approval.
  let sessionId = found.row.fit_session_id ?? null;
  let legacyInvite: Record<string, unknown> | null = null;
  if (!sessionId && found.row.fitter_invite_id) {
    const { data: invite } = (await supabase
      .from("fitter_invites")
      .select(
        "fit_session_id, status, completed_at, recommended_mask_id, recommended_mask_name, recommended_mask_type, recommendations",
      )
      .eq("id", found.row.fitter_invite_id)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    sessionId = (invite?.fit_session_id as string | null) ?? null;
    if (!sessionId && invite?.recommended_mask_id) legacyInvite = invite;
    if (sessionId) {
      await supabase
        .from("referrals")
        .update({
          fit_session_id: sessionId,
          fitting_completed_at: new Date().toISOString(),
          status:
            found.row.status === "awaiting_fitting"
              ? "fitting_complete"
              : found.row.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id.data);
      await recordReferralEvent(found.orgId, id.data, "fitting.completed", {
        actorKind: "system",
        detail: {},
      });
    }
  }

  // The legacy completion, surfaced but LABELLED. The provider gets
  // something to approve rather than a permanently-pending referral, and
  // `source: "legacy"` tells both the SPA and the DME that this record is
  // thinner than a clinical session: no size, no alternatives, no
  // formulary provenance, no safety screening. Presenting it as
  // equivalent would be the actually-misleading option.
  if (!sessionId && legacyInvite) {
    const ranked = Array.isArray(legacyInvite.recommendations)
      ? (legacyInvite.recommendations as Array<Record<string, unknown>>)
      : [];
    res.json({
      status: "complete",
      source: "legacy",
      session: {
        id: null,
        outcome: null,
        recommendationConfidence: null,
        scanQualityGrade: null,
        measurementConfidenceBand: null,
        primary: {
          maskId: String(legacyInvite.recommended_mask_id),
          maskSlug: String(legacyInvite.recommended_mask_id),
          name: (legacyInvite.recommended_mask_name as string) ?? null,
          interfaceType: (legacyInvite.recommended_mask_type as string) ?? null,
          cushion: null,
          frame: null,
          reasons: [],
          cautions: [],
        },
        alternatives: ranked.slice(1).map((r) => ({
          maskId: String(r.maskId ?? ""),
          maskSlug: String(r.maskId ?? ""),
          name: (r.name as string) ?? null,
          interfaceType: (r.type as string) ?? null,
          confidence: typeof r.confidence === "number" ? r.confidence : null,
          cushion: null,
          rankedBelowBecause: null,
        })),
        excluded: [],
        safetyFlags: [],
        degraded: false,
        rulesEngineVersion: null,
        formularyName: null,
        formularyVersion: null,
        completedAt: (legacyInvite.completed_at as string) ?? null,
      },
    });
    return;
  }

  if (!sessionId) {
    res.json({ status: "pending", session: null });
    return;
  }

  const { data: session } = (await supabase
    .from("fit_sessions")
    .select(
      "id, outcome, recommendation_confidence, scan_quality_grade, measurement_confidence_band, primary_recommendation, alternatives, excluded, safety_flags, degraded, rules_engine_version, formulary_name, formulary_version, created_at",
    )
    .eq("id", sessionId)
    .limit(1)
    .maybeSingle()) as { data: Record<string, unknown> | null };

  if (!session) {
    res.json({ status: "pending", session: null });
    return;
  }

  res.json({
    status: "complete",
    source: "clinical",
    session: {
      id: String(session.id),
      outcome: session.outcome,
      recommendationConfidence: session.recommendation_confidence,
      scanQualityGrade: session.scan_quality_grade,
      measurementConfidenceBand: session.measurement_confidence_band,
      primary: session.primary_recommendation,
      alternatives: session.alternatives ?? [],
      excluded: session.excluded ?? [],
      safetyFlags: session.safety_flags ?? [],
      degraded: Boolean(session.degraded),
      rulesEngineVersion: session.rules_engine_version,
      formularyName: session.formulary_name,
      formularyVersion: session.formulary_version,
      completedAt: session.created_at,
    },
  });
});

// ── Approval ─────────────────────────────────────────────────────────

router.post(
  "/api/provider/referrals/:id/approve",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = approveBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Changing the approved mask after signing would swap the equipment
    // out from under the signature just as surely as a PATCH would.
    if (found.row.signed_at) {
      res.status(409).json({
        error: "already_signed",
        message:
          "This order is already signed. Withdraw the referral and start " +
          "a new one to order a different mask.",
      });
      return;
    }
    if (found.row.submitted_at) {
      res.status(409).json({
        error: "already_submitted",
        message: "This referral is already with the DME.",
      });
      return;
    }

    const supabase = getOrgScopedClient(found.orgId);

    // The mask has to exist and be visible to the RECEIVING DME — a
    // referral that names something the DME cannot dispense is worse than
    // no referral, because it looks actionable.
    const { data: model } = (await supabase
      .raw()
      .schema("resupply")
      .from("mask_models")
      .select("id, slug, manufacturer, model_name")
      .or(`org_id.is.null,org_id.eq.${found.orgId}`)
      .eq("id", body.data.maskModelId)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    if (!model) {
      res.status(400).json({
        error: "unknown_mask",
        message: "That mask isn't in this provider's catalog.",
      });
      return;
    }
    if (body.data.variantId) {
      const { data: variant } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_size_variants")
        .select("id")
        .eq("id", body.data.variantId)
        .eq("mask_model_id", body.data.maskModelId)
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      if (!variant) {
        res.status(400).json({
          error: "unknown_size",
          message: "That size doesn't belong to the mask you selected.",
        });
        return;
      }
    }

    // Is this an override of what the engine recommended? Resolved from the
    // session rather than trusted from the request, because the note
    // requirement hangs off it — a clinician overriding an automated
    // recommendation has to say why, and letting the client decide whether
    // it counts as an override would make that requirement optional.
    let isOverride = false;
    if (found.row.fit_session_id) {
      const { data: session } = (await supabase
        .from("fit_sessions")
        .select("primary_recommendation")
        .eq("id", found.row.fit_session_id)
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      const primary = session?.primary_recommendation as {
        maskSlug?: string;
        maskId?: string;
      } | null;
      // A withheld recommendation (low confidence / contraindicated) means
      // there is nothing to override — the provider is making the first
      // clinical call, not contradicting one.
      if (primary) {
        const recommended = primary.maskId ?? primary.maskSlug ?? null;
        isOverride =
          recommended !== null &&
          recommended !== String(model.id) &&
          recommended !== String(model.slug);
      }
    }

    const note = body.data.note?.trim() ?? "";
    if (isOverride && note.length < 10) {
      res.status(400).json({
        error: "override_note_required",
        message:
          "You've selected a different mask to the one the fitting " +
          "recommended. Please say why in a sentence — it goes on the " +
          "referral so the DME and anyone reviewing it later can see the " +
          "reasoning.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabase
      .from("referrals")
      .update({
        approved_mask_model_id: body.data.maskModelId,
        approved_variant_id: body.data.variantId ?? null,
        approval_is_override: isOverride,
        approval_note: note || null,
        approved_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "update_failed" });
      return;
    }

    await recordReferralEvent(found.orgId, id.data, "mask.approved", {
      actorKind: "provider",
      actorEmail: account.emailLower,
      detail: { maskModelId: body.data.maskModelId, isOverride },
    });

    res.json({
      ok: true,
      isOverride,
      mask: `${model.manufacturer} ${model.model_name}`,
    });
  },
);

// ── Signature ────────────────────────────────────────────────────────

/**
 * Raise the referral order into the provider's existing signing queue.
 *
 * Deliberately NOT a second signing path. The order becomes an ordinary
 * `provider_signature_requests` row with `subject_type='referral'`
 * (migration 0487 widened the vocabulary), so it is signed with the same
 * capture, the same ESIGN attestation, and the same hash-chained
 * signature log as a DWO or a prescription — and the provider signs it
 * from the queue screen they already know. `portal.ts` advances the
 * referral when that signature lands.
 */
router.post(
  "/api/provider/referrals/:id/signature",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (found.row.signed_at) {
      res.status(409).json({
        error: "already_signed",
        message: "This referral order has already been signed.",
      });
      return;
    }
    // Signing an order that names no mask would be signing a blank.
    if (!found.row.approved_mask_model_id) {
      res.status(409).json({
        error: "no_approved_mask",
        message:
          "Approve a mask before signing — the order has to say what is " +
          "being ordered.",
      });
      return;
    }

    const supabase = getOrgScopedClient(found.orgId);
    const patientName =
      `${found.row.patient_first_name} ${found.row.patient_last_name}`.trim();

    try {
      // An existing pending request is reused rather than duplicated: two
      // pending signature requests for one order is a way to get the same
      // thing signed twice and leave the audit trail ambiguous.
      if (found.row.signature_request_id) {
        const { data: existing } = (await supabase
          .raw()
          .schema("resupply")
          .from("provider_signature_requests")
          .select("id, status")
          .eq("id", found.row.signature_request_id)
          .eq("org_id", found.orgId)
          .limit(1)
          .maybeSingle()) as { data: Record<string, unknown> | null };
        if (existing && existing.status === "pending") {
          res.json({
            ok: true,
            signatureRequestId: String(existing.id),
            reused: true,
          });
          return;
        }
      }

      // Resolve what is actually being ordered, in words.
      //
      // The signing screen renders `detail` and nothing else — it does not
      // load the referral. So anything the clinician needs to see before
      // attesting has to be IN here, and it has to be a snapshot: an order
      // is signed as it stood at the moment of signing, not as whatever
      // the referral says later.
      const { data: model } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_models")
        .select("manufacturer, model_name, interface_type")
        .eq("id", found.row.approved_mask_model_id)
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      let sizeLabel: string | null = null;
      if (found.row.approved_variant_id) {
        const { data: variant } = (await supabase
          .raw()
          .schema("resupply")
          .from("mask_size_variants")
          .select("size_label, component")
          .eq("id", found.row.approved_variant_id)
          .limit(1)
          .maybeSingle()) as { data: Record<string, unknown> | null };
        sizeLabel = variant ? String(variant.size_label) : null;
      }

      const pressure = found.row.prescribed_pressure_cm_h2o;
      const orderSummary: Array<{ label: string; value: string }> = [
        { label: "Patient", value: patientName },
        ...(found.row.patient_dob
          ? [{ label: "Date of birth", value: String(found.row.patient_dob) }]
          : []),
        {
          label: "Mask",
          value: model
            ? `${model.manufacturer} ${model.model_name}`
            : "Unresolved — do not sign",
        },
        { label: "Size", value: sizeLabel ?? "Not specified" },
        {
          label: "Therapy",
          value: String(found.row.therapy_mode ?? "pap").toUpperCase(),
        },
        ...(pressure != null
          ? [{ label: "Prescribed pressure", value: `${pressure} cmH₂O` }]
          : []),
        ...(found.row.diagnosis_code
          ? [{ label: "Diagnosis", value: String(found.row.diagnosis_code) }]
          : []),
        {
          label: "Referred to",
          value: found.row.organizations?.name ?? "the receiving supplier",
        },
      ];

      // A mask that cannot be resolved must not reach an attestation — the
      // clinician would be signing for equipment nobody can name.
      if (!model) {
        res.status(409).json({
          error: "unresolved_mask",
          message:
            "The approved mask could not be found in the catalog, so the " +
            "order cannot be prepared for signature. Re-approve a mask.",
        });
        return;
      }

      // provider_signature_requests is a BLOCKED TENANT table — raw
      // client + MANUAL org_id on the inserted row, matching how
      // routes/admin/provider-esign.ts creates one.
      const { data: inserted, error } = (await supabase
        .raw()
        .schema("resupply")
        .from("provider_signature_requests")
        .insert({
          provider_id: account.providerId,
          org_id: found.orgId,
          account_id: account.id,
          patient_id: found.row.patient_id ?? null,
          subject_type: "referral",
          subject_id: id.data,
          title: `Referral order — ${patientName}`,
          patient_name_snapshot: patientName,
          detail: {
            referralId: id.data,
            maskModelId: found.row.approved_mask_model_id,
            variantId: found.row.approved_variant_id ?? null,
            therapyMode: found.row.therapy_mode ?? "pap",
            // The human-readable snapshot the signing screen renders.
            // `orderSummary` is the contract with provider-sign-document.tsx.
            orderSummary,
          },
          status: "pending",
          created_by_email: account.emailLower,
        })
        .select("id")
        .single()) as {
        data: { id: string } | null;
        error: { message: string } | null;
      };
      if (error || !inserted) {
        res.status(500).json({ error: "insert_failed" });
        return;
      }

      const nowIso = new Date().toISOString();
      await supabase
        .from("referrals")
        .update({
          signature_request_id: inserted.id,
          status: "awaiting_signature",
          updated_at: nowIso,
        })
        .eq("id", id.data);

      await recordReferralEvent(found.orgId, id.data, "signature.requested", {
        actorKind: "provider",
        actorEmail: account.emailLower,
        detail: { signatureRequestId: inserted.id },
      });

      res.status(201).json({
        ok: true,
        signatureRequestId: inserted.id,
        reused: false,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "referral signature request failed",
      );
      res.status(500).json({ error: "insert_failed" });
    }
  },
);

// ── Submit ───────────────────────────────────────────────────────────

router.post("/api/provider/referrals/:id/submit", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const id = uuid.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }
  const found = await loadReferralForProvider(account.providerId, id.data);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (found.row.status === "cancelled" || found.row.status === "declined") {
    res.status(409).json({ error: "not_active" });
    return;
  }
  if (found.row.submitted_at) {
    res.status(409).json({
      error: "already_submitted",
      message: "This referral is already with the DME.",
    });
    return;
  }

  // Authorization is re-checked HERE, not just at create time. A DME can
  // revoke a provider after a draft was started, and the admin UI
  // promises revoking "stops any new referrals from them immediately" —
  // which is only true if the check runs at the moment of delivery.
  if (!(await providerMayReferTo(account.providerId, found.orgId))) {
    res.status(403).json({
      error: "destination_not_authorized",
      message:
        "This supplier is no longer accepting referrals from you, so this " +
        "one can't be sent. Contact them, or start a referral to a " +
        "different supplier.",
    });
    return;
  }

  // What the receiving DME actually needs to act on it. Blocking here
  // rather than letting an incomplete referral land in their queue is the
  // whole point — an incomplete referral is a phone call, which is the
  // thing this portal exists to remove.
  //
  // The SIGNATURE is the one of these that is not merely administrative.
  // A referral order names a specific mask and size and is what the DME
  // dispenses and bills against; unsigned, it is a suggestion the DME
  // cannot act on. The lifecycle models this explicitly
  // (awaiting_signature → signed → submitted) and the SPA only offers
  // "Send to the DME" after signing — but the UI is not the gate, so
  // enforce it here too rather than trusting the client to walk the
  // states in order. A tenant that genuinely does not require signed
  // orders should get a setting, not an unguarded endpoint.
  const missing: string[] = [];
  if (!found.row.patient_dob) missing.push("the patient's date of birth");
  if (!found.row.insurance_payer_name) missing.push("the insurance payer");
  if (!found.row.approved_mask_model_id) missing.push("an approved mask");
  if (!found.row.signed_at) missing.push("your signature on the order");

  const supabase = getOrgScopedClient(found.orgId);
  const { data: docs } = (await supabase
    .from("referral_documents")
    .select("doc_type")
    .eq("referral_id", id.data)
    .limit(100)) as { data: Record<string, unknown>[] | null };
  const docTypes = new Set((docs ?? []).map((d) => String(d.doc_type)));
  if (!docTypes.has("prescription")) missing.push("a prescription");

  if (missing.length > 0) {
    res.status(409).json({
      error: "incomplete",
      missing,
      message: `Before this can go to the DME it still needs ${listPhrase(missing)}.`,
    });
    return;
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("referrals")
    .update({
      status: "submitted",
      submitted_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", id.data);
  if (error) {
    res.status(500).json({ error: "update_failed" });
    return;
  }
  await recordReferralEvent(found.orgId, id.data, "referral.submitted", {
    actorKind: "provider",
    actorEmail: account.emailLower,
    detail: { documentCount: docTypes.size },
  });

  res.json({ ok: true, status: "submitted" });
});

/** "a, b and c" — used in the blocking message above. */
function listPhrase(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Deliver the fitting link to the patient.
 *
 * Mirrors the staff-side `deliverInvite` in routes/admin/fitter-invites.ts
 * and shares its posture: never throws on a vendor or config failure, so
 * the caller can still hand the provider a copy-able link.
 */
async function deliverFittingLink(opts: {
  orgId: string;
  channel: "email" | "sms";
  email: string | null;
  phone: string | null;
  firstName: string;
  link: string;
}): Promise<{ delivered: boolean; reason: string | null }> {
  const { createTenantSendgridClient } =
    await import("../../lib/email/tenant-sender.js");
  const { resolveBrandingByOrgId } =
    await import("../../lib/tenant-branding.js");
  const brandName = (await resolveBrandingByOrgId(opts.orgId)).storefrontName;
  const greeting = opts.firstName || "there";

  try {
    if (opts.channel === "sms") {
      if (!opts.phone) return { delivered: false, reason: "no_phone" };
      const { createTwilioSmsClient, TwilioConfigError } =
        await import("@workspace/resupply-telecom");
      const { resolveTenantSmsClientOptions } =
        await import("../../lib/messaging/tenant-telecom.js");
      try {
        const twilio = createTwilioSmsClient(
          await resolveTenantSmsClientOptions(opts.orgId),
        );
        await twilio.sendSms({
          to: opts.phone,
          body:
            `Hi ${greeting}, your doctor has asked ${brandName} to find you ` +
            `the best-fitting CPAP mask. It takes about two minutes on your ` +
            `phone: ${opts.link}`,
        });
        return { delivered: true, reason: null };
      } catch (err) {
        if (err instanceof TwilioConfigError) {
          return { delivered: false, reason: "no_sms_config" };
        }
        throw err;
      }
    }

    if (!opts.email) return { delivered: false, reason: "no_email" };
    const sendgrid = await createTenantSendgridClient(opts.orgId);
    const safeBrand = brandName.replace(/[\r\n]/g, "");
    await sendgrid.sendEmail({
      to: opts.email,
      // No PHI in the subject line.
      subject: `Find your best CPAP mask fit with ${safeBrand}`,
      html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Your doctor has asked <strong>${escapeHtml(safeBrand)}</strong> to help
  you find the CPAP mask that fits you best. It takes about two minutes and
  runs entirely on your own phone or computer.</p>
  <p style="margin:24px 0">
    <a href="${escapeHtml(opts.link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Start your mask fitting</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Your camera images never leave your
  device — only the numeric measurements are shared with your care team.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link into your browser:<br>${escapeHtml(opts.link)}</p>
  </body></html>`,
      text: [
        `Hi ${greeting},`,
        "",
        `Your doctor has asked ${safeBrand} to help you find the CPAP mask`,
        "that fits you best. It takes about two minutes and runs entirely on",
        "your own phone or computer.",
        "",
        opts.link,
        "",
        "Your camera images never leave your device — only the numeric",
        "measurements are shared with your care team.",
      ].join("\n"),
    });
    return { delivered: true, reason: null };
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        channel: opts.channel,
      },
      "referral fitting link delivery failed",
    );
    return { delivered: false, reason: "send_failed" };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
