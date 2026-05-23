// /portal/clinician/:token — public read-only referral status page
// for EHR partners that don't consume our webhook callbacks
// (Phase 5). An admin mints a token via
// POST /admin/inbound-referrals/:id/share-tokens; the clinician
// follows the link from their portal and sees the same lifecycle
// ribbon the CSR sees, sanitised to remove all PHI beyond what the
// clinician already submitted.
//
// Auth: HMAC-signed token (lib/clinician-share-token.ts) + a DB
// lookup that enforces revoked_at and the authoritative expires_at.
// No session cookie required — the token IS the auth.
//
// Rate limit: IP-keyed at 60/min so a brute-force enumeration of
// share row IDs through the public surface can't spin CPU on HMAC
// verification.
//
// PHI posture: response includes
//   - source order id (the clinician already sent us this)
//   - triage status + accept timestamps
//   - status callback timeline (events + outcomes)
//   - preflight check kinds + outcome status (NOT the outcome json,
//     which can include patient/coverage IDs)
// Response NEVER includes patient name, dob, address, phone, email,
// member id, hcpcs lines, or icd-10 codes — even though those exist
// on the referral row.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { verifyClinicianShareToken } from "../lib/clinician-share-token";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const tokenParam = z.object({
  token: z.string().min(8).max(2000),
});

// 60/min per IP. Higher than the inbound-webhook rate limiter
// because legitimate clinicians may re-load the page while talking
// to a patient.
const portalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

router.get(
  "/portal/clinician/:token",
  portalRateLimiter,
  async (req, res) => {
    const parsed = tokenParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const verifyOutcome = verifyClinicianShareToken(parsed.data.token);
    if (!verifyOutcome.valid) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: share } = await supabase
      .schema("resupply")
      .from("clinician_share_tokens")
      .select(
        "id, referral_id, expires_at, revoked_at, view_count",
      )
      .eq("id", verifyOutcome.shareRowId)
      .limit(1)
      .maybeSingle();
    if (!share) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (share.revoked_at !== null) {
      res.status(410).json({ error: "revoked" });
      return;
    }
    if (Date.parse(share.expires_at) <= Date.now()) {
      res.status(410).json({ error: "expired" });
      return;
    }

    const [
      { data: referral },
      { data: outboxRows },
      { data: preflightChecks },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("inbound_referral_orders")
        .select(
          "id, source, source_order_id, triage_status, accepted_at, accepted_order_kind, triaged_at, received_at, preflight_completed_at",
        )
        .eq("id", share.referral_id)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("inbound_referral_status_outbox")
        .select("event_type, status, delivered_at, created_at")
        .eq("referral_id", share.referral_id)
        .order("created_at", { ascending: true }),
      supabase
        .schema("resupply")
        .from("inbound_referral_preflight_checks")
        .select("check_kind, outcome_status, created_at")
        .eq("referral_id", share.referral_id)
        .order("created_at", { ascending: true }),
    ]);

    if (!referral) {
      // Referral was hard-deleted (FK cascades), token row was too.
      // Defensive 404.
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Stamp view + bump count. Fire-and-forget; the response goes
    // out regardless.
    void supabase
      .schema("resupply")
      .from("clinician_share_tokens")
      .update({
        last_viewed_at: new Date().toISOString(),
        last_viewed_ip: req.ip ?? null,
        view_count: share.view_count + 1,
      })
      .eq("id", share.id)
      .then(() => undefined);

    await logAudit({
      action: "inbound_referral.clinician_share_viewed",
      adminEmail: "system:portal:clinician",
      adminUserId: null,
      targetTable: "clinician_share_tokens",
      targetId: share.id,
      metadata: {
        referral_id: share.referral_id,
        view_count: share.view_count + 1,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "inbound_referral.clinician_share_viewed audit write failed",
      );
    });

    // Public response shape. Every field below was either sent TO
    // us by the clinician's EHR (source order id, status) or is
    // structural (event kind + outcome label). No patient PHI.
    res.json({
      sourceOrderId: referral.source_order_id,
      source: referral.source,
      status: referral.triage_status,
      receivedAt: referral.received_at,
      triagedAt: referral.triaged_at,
      acceptedAt: referral.accepted_at,
      acceptedOrderKind: referral.accepted_order_kind,
      preflightCompletedAt: referral.preflight_completed_at,
      preflightSummary: (preflightChecks ?? []).map((c) => ({
        kind: c.check_kind,
        status: c.outcome_status,
        at: c.created_at,
      })),
      timeline: (outboxRows ?? []).map((o) => ({
        eventType: o.event_type,
        status: o.status,
        deliveredAt: o.delivered_at,
        at: o.created_at,
      })),
      // Footer: when this link expires + view count for transparency.
      expiresAt: share.expires_at,
      viewCount: share.view_count + 1,
    });
  },
);

export default router;
