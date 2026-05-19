// /integrations/inbound/:source — public-mount inbound webhook intake.
//
// Receives webhooks from third parties (Parachute Health, HSAT
// vendors, future Stripe events) into a single inbox. Each source
// gets a small per-source dispatcher (in lib/inbound-dispatchers/)
// that runs after the row lands.
//
// MVP scope: persist + dedupe + audit. Per-source signature
// verification + dispatcher logic ships per source as partner
// agreements land. The route shape is forward-compatible.

import { createHash } from "node:crypto";

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../lib/logger";

const router: IRouter = Router();

// We don't gate this route with requireAdmin (it's a partner-callable
// webhook). Each source dispatcher is responsible for verifying the
// signature header before marking signature_verified = true.

const sourceParam = z.object({
  source: z
    .string()
    .regex(/^[a-z0-9_]{2,40}$/, "source slug is letters/digits/underscores"),
});

const SUPPORTED_SOURCES = new Set(["parachute", "itamar_hsat", "test"]);

router.post("/integrations/inbound/:source", async (req, res) => {
  const parsed = sourceParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_source" });
    return;
  }
  const source = parsed.data.source;
  if (!SUPPORTED_SOURCES.has(source)) {
    res.status(404).json({ error: "unknown_source" });
    return;
  }
  const payload = req.body as unknown;
  if (!payload || typeof payload !== "object") {
    res.status(400).json({ error: "invalid_payload" });
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
    const sha = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    dedupeKey = `sha256:${sha}`;
  }
  const sourceEventType =
    typeof (payload as Record<string, unknown>).type === "string"
      ? ((payload as Record<string, unknown>).type as string).slice(0, 120)
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

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_webhooks")
    .insert({
      source,
      source_event_type: sourceEventType,
      payload_json: payload as unknown as Json,
      verification_headers_json: verificationHeaders as unknown as Json,
      signature_verified: false,
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

export default router;
