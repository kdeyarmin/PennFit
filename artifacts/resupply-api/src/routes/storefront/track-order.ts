// POST /api/orders/track — public order-status lookup keyed on
// order_reference + email.
//
// Why
// ---
// Today /shop/orders requires a signed-in session — a guest checkout
// (or a patient who never created an account) has no way to see if
// their order shipped. The result is a high-volume "where's my
// order?" inbound to CSR that a 30-second public lookup would
// deflect entirely.
//
// Surface
// -------
// One read endpoint:
//
//   POST /api/orders/track
//        { orderReference, email }
//   →    { status, mask, shippedAt?, deliveredAt?, tracking? }
//
// We require BOTH the reference AND the email to match — the
// reference alone is only 6 characters and enumerable, so an
// attacker who guessed a reference still needs the email on file
// for that reference. Per-IP rate limit is tight (10/15min) to
// prevent brute-forcing the (reference × email) pair.
//
// The lookup, the email-mismatch-as-not-found behavior, and the rate
// bucket all live in lib/storefront/orderTracking.ts — shared with
// the chatbot's `track_order` tool so both surfaces draw from the
// same per-IP budget and return the same fields.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  ORDER_REFERENCE_PATTERN,
  lookupTrackedOrder,
  normalizeOrderReference,
  trackOrderRateLimited,
} from "../../lib/storefront/orderTracking.js";

const router: IRouter = Router();

const body = z
  .object({
    orderReference: z
      .string()
      .trim()
      .toUpperCase()
      // Exactly "PENN-" + 6 alphanumerics, or just the 6-char tail.
      // A shorter tail is brute-forceable in tens of thousands of
      // guesses; see ORDER_REFERENCE_PATTERN for the full rationale.
      .regex(ORDER_REFERENCE_PATTERN, "must be a PennPaps order reference"),
    email: z.string().trim().toLowerCase().email().max(200),
  })
  .strict();

router.post("/orders/track", async (req, res) => {
  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  if (trackOrderRateLimited(ip + ":track")) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const parsed = body.safeParse(req.body);
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
  // The zod regex above guarantees normalization can't fail here.
  const normalizedRef =
    normalizeOrderReference(parsed.data.orderReference) ??
    parsed.data.orderReference;

  const result = await lookupTrackedOrder(normalizedRef, parsed.data.email);
  if (result.outcome === "lookup_failed") {
    req.log?.warn?.(
      { err: result.detail },
      "orders.track: legacy read failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (result.outcome === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Counts-only log — never the reference or the email.
  req.log?.info?.(
    { event: "orders.track.served", emailStatus: result.order.emailStatus },
    "orders.track: order surfaced",
  );

  res.json({
    orderReference: result.order.orderReference,
    mask: result.order.mask,
    createdAt: result.order.createdAt,
    emailStatus: result.order.emailStatus,
    emailDeliveredAt: result.order.emailDeliveredAt,
  });
});

export default router;

// Test-only seam — kept exported from this module because the route
// tests import it from here; clears the shared in-memory rate bucket.
export { _resetTrackOrderRateBucketForTests } from "../../lib/storefront/orderTracking.js";
