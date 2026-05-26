// /integrations/inbound/:source — public-mount inbound webhook intake.
//
// Receives webhooks from third parties (Parachute Health, HSAT
// vendors, future Stripe events) into a single inbox. Each source
// gets a small per-source dispatcher (in lib/inbound-dispatchers/)
// that runs after the row lands.
//
// Two-stage flow:
//   1. THIS route persists the raw body verbatim into
//      inbound_webhooks (after dedupe + per-source inline signature
//      verification when the secret is configured).
//   2. A worker (worker/jobs/inbound-webhook-dispatch.ts) reads
//      pending rows and routes each to its per-source dispatcher
//      (lib/inbound-dispatchers/<source>.ts) which parses + creates
//      the typed referral row.
//
// We MUST receive the raw bytes (not a parsed JSON object) on this
// route because partner HMACs are computed over those exact bytes;
// re-serialising req.body would change whitespace + key order.
// `express.raw({ type: "application/json" })` is applied per-route.

import { createHash } from "node:crypto";

import express, { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { verifyParachuteSignature } from "@workspace/resupply-integrations-parachute";

import { logger } from "../lib/logger";
import { RATE_LIMITS } from "../lib/rate-limits-config";

const router: IRouter = Router();

// We don't gate this route with requireAdmin (it's a partner-callable
// webhook). Per-source inline signature verification is enforced
// below when the source's secret env var is set; missing secret =>
// signature_verified=false and a downstream dispatcher decides what
// to do (dev/preview deploys without partner secrets configured can
// still receive test traffic via the 'test' source slug).

const sourceParam = z.object({
  source: z
    .string()
    .regex(/^[a-z0-9_]{2,40}$/, "source slug is letters/digits/underscores"),
});

const SUPPORTED_SOURCE_SET = new Set(["parachute", "itamar_hsat", "test"]);

/**
 * Accept a source slug if it's in the hard-coded set OR matches the
 * `ehr_fhir_<tenant_slug>` pattern. The tenant existence check
 * happens lazily — the dispatcher (lib/inbound-dispatchers/ehr-fhir.ts)
 * refuses to land a referral if signature_verified=false, and the
 * normal POST path lands here only after middleware sets
 * signature_verified=true. A non-FHIR partner posting plain JSON to
 * /integrations/inbound/ehr_fhir_<tenant> would land with
 * signature_verified=false and be rejected by the dispatcher.
 */
function isSupportedSource(source: string): boolean {
  if (SUPPORTED_SOURCE_SET.has(source)) return true;
  return /^ehr_fhir_[a-z0-9_]{2,38}$/.test(source);
}

// Body cap mirrors the manufacturer-cloud webhooks route. 1MB is
// well above any plausible inbound order payload — Parachute's
// largest events (with embedded document metadata) run ~50KB.
const rawJson = express.raw({ type: "application/json", limit: "1mb" });

// Defense-in-depth IP rate limit for the partner-callable inbound
// webhook intake. This route is unauthenticated at the transport
// layer (partner auth happens via per-source HMAC verification
// inline below), so without a limiter a single attacker IP could
// burn database write capacity by POSTing millions of malformed or
// signature-failing payloads. 120 requests / minute / IP is well
// above the burstiest partner replay window (Parachute caps its
// retry storm at ~30/min) but cuts off scripted abuse early.
// Keyed on req.ip because no authenticated identity is available at
// this point in the request lifecycle. Uses `express-rate-limit`
// directly (rather than the in-house `rateLimit` helper) so static
// analyzers recognize the gate on this unauthenticated endpoint.
const inboundWebhookLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.integrations_inbound_dispatch.windowMs,
  limit: RATE_LIMITS.integrations_inbound_dispatch.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests", limiter: "integrations_inbound_ip" },
});

router.post("/integrations/inbound/:source", inboundWebhookLimiter, rawJson, async (req, res) => {
  const parsed = sourceParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_source" });
    return;
  }
  const source = parsed.data.source;
  if (!isSupportedSource(source)) {
    res.status(404).json({ error: "unknown_source" });
    return;
  }
  // req.body is a Buffer (express.raw). Parse it ourselves so we
  // keep the exact-bytes string around for signature verification.
  const rawBuffer = req.body;
  if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length === 0) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }
  const rawBodyString = rawBuffer.toString("utf8");
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBodyString);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }


  // Build a dedupe key — prefer the source's delivery-id header,
  // fall back to a sha256 of the body.
  const headerKeys = [
    "x-parachute-delivery-id",
    "x-itamar-event-id",
    "x-stripe-event-id",
    "x-delivery-id",
  ];
  let dedupeKey = "";
  for (const k of headerKeys) {
    const v = req.headers[k];
    if (typeof v === "string" && v.length > 0) {
      dedupeKey = `${k}:${v.slice(0, 120)}`;
      break;
    }
  }
  if (!dedupeKey) {
    const sha = createHash("sha256").update(rawBuffer).digest("hex");
    dedupeKey = `sha256:${sha}`;
  }
  const sourceEventType =
    typeof payload.type === "string"
      ? (payload.type as string).slice(0, 120)
      : typeof payload.event_type === "string"
        ? (payload.event_type as string).slice(0, 120)
        : null;
  // Capture verification-relevant headers only (no Cookie, no Auth).
  const verificationHeaders: Record<string, string> = {};
  for (const k of headerKeys) {
    const v = req.headers[k];
    if (typeof v === "string") verificationHeaders[k] = v;
  }
  for (const k of [
    "x-parachute-signature",
    "x-itamar-signature",
    "stripe-signature",
  ]) {
    const v = req.headers[k];
    if (typeof v === "string") verificationHeaders[k] = v;
  }

  // Per-source inline signature verification. Failure is a 401 so
  // forged payloads never land in inbound_webhooks at all. When the
  // source's secret env var is unset we accept the payload with
  // signature_verified=false — dev/preview deploys without partner
  // credentials need to be able to receive test traffic.
  const sigOutcome = verifyInlineSignature(source, rawBodyString, req.headers);
  if (sigOutcome.outcome === "configured_bad") {
    logger.warn(
      { source, reason: sigOutcome.reason },
      "integrations.inbound: signature rejected",
    );
    res.status(401).json({ error: "invalid_signature" });
    return;
  }
  const signatureVerified = sigOutcome.outcome === "configured_ok";

  // Dedupe key safety: when the request is NOT signature-verified
  // (dev/preview without partner secrets), we must NOT trust the
  // partner-supplied delivery-id header for dedupe. Otherwise an
  // unauthenticated attacker can pre-poison the dedupe slot for any
  // future legitimate delivery id — every real later webhook for
  // that id would 200-deduplicate without ever being processed.
  // Force sha256(body) for unverified inserts so the attacker's
  // poison row sits in a body-content slot that a real partner
  // payload will never collide with.
  if (!signatureVerified) {
    const sha = createHash("sha256").update(rawBuffer).digest("hex");
    dedupeKey = `sha256:${sha}`;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .insert({
      source,
      source_event_type: sourceEventType,
      payload_json: payload as unknown as Json,
      verification_headers_json: verificationHeaders as unknown as Json,
      signature_verified: signatureVerified,
      dedupe_key: dedupeKey,
      status: "received",
    });
  if (error) {
    // Duplicate on (source, dedupe_key) → 200 + duplicate marker so
    // the sender doesn't retry forever.
    if (typeof error.code === "string" && error.code === "23505") {
      logger.info(
        { source, dedupeKey },
        "integrations.inbound: duplicate, acked without re-processing",
      );
      res.status(200).json({ ok: true, deduped: true });
      return;
    }
    throw error;
  }
  await logAudit({
    action: "integrations.inbound_received",
    adminEmail: "system:integrations:inbound",
    adminUserId: null,
    targetTable: "inbound_webhooks",
    targetId: null,
    metadata: { source, source_event_type: sourceEventType, dedupe_key: dedupeKey },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "integrations.inbound_received audit write failed");
  });
  res.status(202).json({ ok: true });
});

type SigOutcome =
  | { outcome: "no_secret" }
  | { outcome: "configured_ok" }
  | { outcome: "configured_bad"; reason: string };

/**
 * Perform per-source inline signature verification for an inbound webhook.
 *
 * @param source - The integration source identifier (e.g., `"parachute"`)
 * @param rawBody - The raw UTF-8 request body string used for signature verification
 * @param headers - The incoming request headers
 * @returns `{ outcome: "configured_ok" }` if a signing secret is configured and the signature matches,
 * `{ outcome: "configured_bad"; reason: string }` if a secret is configured but the signature check fails,
 * `{ outcome: "no_secret" }` if no signing secret is configured or inline verification is not implemented for the source. 
 */
function verifyInlineSignature(
  source: string,
  rawBody: string,
  headers: IncomingHttpHeaders,
): SigOutcome {
  if (source === "parachute") {
    const secret = process.env.PARACHUTE_SIGNING_SECRET;
    if (!secret) return { outcome: "no_secret" };
    const sig = headers["x-parachute-signature"];
    const result = verifyParachuteSignature({
      rawBody,
      signatureHeader: typeof sig === "string" ? sig : null,
      signingSecret: secret,
    });
    return result.ok
      ? { outcome: "configured_ok" }
      : { outcome: "configured_bad", reason: result.reason };
  }
  // Other sources have no inline-verification path yet. They land
  // with signature_verified=false; their dispatcher decides what to
  // do with that.
  return { outcome: "no_secret" };
}

export default router;
