// /integrations/webhooks/:vendor — vendor push notifications.
//
// AirView and Care Orchestrator both support webhook callbacks
// when a new night of therapy data lands or a device-settings
// change is pushed from the cloud. Today we don't expose enough
// of the partner data to ACT on those events end-to-end, but
// we DO want to:
//   1. Verify the signature so a forged webhook can't kick off a
//      refresh storm against a real partner.
//   2. Mark the matching patient_therapy_links row as "needs
//      refresh" so the nightly sweep picks it up sooner (or the
//      next manual refresh fires).
//   3. Record an audit row with the event metadata so an operator
//      can trace why a snapshot moved.
//
// Vendor secrets
// --------------
//   * AIRVIEW_WEBHOOK_SECRET     — HMAC-SHA256 over the raw body.
//                                   Header: X-AirView-Signature.
//   * CARE_ORCH_WEBHOOK_SECRET   — same scheme; header:
//                                   X-CareOrchestrator-Signature.
// When the secret env var is unset, the endpoint returns 503 so
// vendors get a clean "not yet wired up" signal instead of 200.
//
// Hard rule: NEVER include the raw body in audit metadata. Only the
// vendor's event type + (optional) patient identifier + signature
// status.

import { createHmac, timingSafeEqual } from "node:crypto";
import express, { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../lib/logger";
import { RATE_LIMITS } from "../lib/rate-limits-config";

const router: IRouter = Router();

// Capture the raw body so we can HMAC it. JSON parse happens after.
const rawJson = express.raw({ type: "application/json", limit: "1mb" });

// IP-keyed rate limiter on the unauthenticated webhook endpoints. The
// HMAC signature check is the primary authorisation gate, but we still
// want a recognised throttle in front (CodeQL `js/missing-rate-limiting`)
// so a flood of forged requests can't burn CPU on signature math or
// audit-log writes for invalid signatures. 300/min/IP is well above
// vendor push volume.
const webhookRateLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.integrations_inbound_webhooks.windowMs,
  limit: RATE_LIMITS.integrations_inbound_webhooks.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

interface VendorConfig {
  envVar: string;
  signatureHeader: string;
  source: "resmed_airview" | "philips_care" | "react_health";
  prefix: string;
}

const VENDORS: Record<string, VendorConfig> = {
  airview: {
    envVar: "AIRVIEW_WEBHOOK_SECRET",
    signatureHeader: "x-airview-signature",
    source: "resmed_airview",
    prefix: "airview",
  },
  "care-orchestrator": {
    envVar: "CARE_ORCH_WEBHOOK_SECRET",
    signatureHeader: "x-careorchestrator-signature",
    source: "philips_care",
    prefix: "care_orchestrator",
  },
  "react-health": {
    envVar: "REACT_HEALTH_WEBHOOK_SECRET",
    signatureHeader: "x-icode-signature",
    source: "react_health",
    prefix: "react_health",
  },
};

function verifySignature(
  secret: string,
  rawBody: Buffer,
  provided: string,
): boolean {
  // Strip an optional `sha256=` prefix (Stripe/GitHub style) so a
  // partner that ships the prefixed header form doesn't 401 for a
  // structural reason that's invisible to operators.
  const stripped = provided.startsWith("sha256=")
    ? provided.slice("sha256=".length)
    : provided;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Pad both to a fixed length before timingSafeEqual so the length
  // mismatch fast-path doesn't leak the expected hex length via
  // response timing, AND so timingSafeEqual doesn't itself throw on
  // unequal-length buffers. 64 hex chars = sha256 length.
  const pad = 64;
  const a = Buffer.alloc(pad);
  const b = Buffer.alloc(pad);
  a.write(expected, "utf8");
  b.write(stripped, "utf8");
  try {
    return timingSafeEqual(a, b) && expected.length === stripped.length;
  } catch {
    return false;
  }
}

const eventSchema = z
  .object({
    eventType: z.string().min(1).max(64),
    partnerPatientId: z.string().min(1).max(128).optional(),
  })
  .passthrough();

router.post(
  "/integrations/webhooks/:vendor",
  webhookRateLimiter,
  rawJson,
  async (req, res) => {
    const vendorParam = z
      .enum(["airview", "care-orchestrator", "react-health"])
      .safeParse(req.params.vendor);
    if (!vendorParam.success) {
      res.status(404).json({ error: "unknown_vendor" });
      return;
    }
    const config = VENDORS[vendorParam.data];
    if (!config) {
      res.status(404).json({ error: "unknown_vendor" });
      return;
    }
    const secret = process.env[config.envVar];
    if (!secret) {
      res.status(503).json({ error: "webhook_not_configured" });
      return;
    }
    const signature = req.header(config.signatureHeader);
    const raw = req.body as Buffer;
    if (!signature || !Buffer.isBuffer(raw)) {
      res.status(400).json({ error: "missing_signature_or_body" });
      return;
    }
    if (!verifySignature(secret, raw, signature)) {
      // Log without the body. A failed signature is a security
      // signal — surveyors want to see we noticed.
      await logAudit({
        action: `integration.webhook.${config.prefix}.invalid_signature`,
        adminEmail: `vendor:${config.source}`,
        adminUserId: null,
        targetTable: null,
        targetId: null,
        metadata: {},
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch(() => {});
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    let parsed;
    try {
      parsed = eventSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // Best-effort: nudge the matching link's last_sync_status so the
    // CSR sees "vendor reported new data" and the next sweep refreshes.
    const supabase = getSupabaseServiceRoleClient();
    let nudgedLinkId: string | null = null;
    if (parsed.partnerPatientId) {
      const { data: link } = await supabase
        .schema("resupply")
        .from("patient_therapy_links")
        .select("id")
        .eq("source", config.source)
        .eq("partner_patient_id", parsed.partnerPatientId)
        .limit(1)
        .maybeSingle();
      if (link) {
        nudgedLinkId = link.id;
        const { error: nudgeErr } = await supabase
          .schema("resupply")
          .from("patient_therapy_links")
          .update({
            last_sync_status: "vendor_pushed",
            last_sync_error: null,
          })
          .eq("id", link.id);
        if (nudgeErr) {
          logger.warn(
            { err: nudgeErr.message, linkId: link.id },
            "integrations-webhooks: vendor_pushed nudge stamp failed (non-fatal)",
          );
        }
      }
    }

    await logAudit({
      action: `integration.webhook.${config.prefix}.received`,
      adminEmail: `vendor:${config.source}`,
      adminUserId: null,
      targetTable: nudgedLinkId ? "patient_therapy_links" : null,
      targetId: nudgedLinkId,
      // Envelope: vendor event type + linked? boolean. Never the
      // body itself, and not the partner_patient_id either —
      // vendors sometimes use the patient's MRN as that key.
      metadata: {
        event_type: parsed.eventType,
        link_matched: !!nudgedLinkId,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, `integration.webhook.${config.prefix} audit failed`);
    });

    res.status(202).json({ ok: true });
  },
);

export default router;
