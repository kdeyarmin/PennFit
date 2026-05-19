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
// Privacy
// -------
// No PHI fields are returned — only the operational status (paid /
// shipped / delivered), the mask the patient picked, and the
// tracking number/carrier if shipped. We deliberately don't return
// the shipping address, physician info, or insurance — those need
// a real session.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

const router: IRouter = Router();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();
const RATE_SWEEP_EVERY = 200;
let rateBucketSweepCounter = 0;

function sweepRateBucket(now: number): void {
  for (const [key, timestamps] of rateBucket) {
    if (timestamps.every((t) => now - t >= RATE_WINDOW_MS)) {
      rateBucket.delete(key);
    }
  }
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  if (++rateBucketSweepCounter % RATE_SWEEP_EVERY === 0) {
    sweepRateBucket(now);
  }
  const arr = (rateBucket.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_MAX) {
    rateBucket.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBucket.set(key, arr);
  return false;
}

const body = z
  .object({
    orderReference: z
      .string()
      .trim()
      .toUpperCase()
      // Reference is "PENN-" + 6 alphanumerics; allow either the
      // full thing or just the 6-char tail.
      .regex(/^(PENN-)?[A-Z0-9]{4,12}$/, "must be a PennPaps order reference"),
    email: z.string().trim().toLowerCase().email().max(200),
  })
  .strict();

router.post("/orders/track", async (req, res) => {
  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  if (rateLimited(ip + ":track")) {
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
  const normalizedRef = parsed.data.orderReference.startsWith("PENN-")
    ? parsed.data.orderReference
    : `PENN-${parsed.data.orderReference}`;

  const supabase = getSupabaseServiceRoleClient();

  // Fitter orders live in public.orders; the shop orders live in
  // resupply.shop_orders. We probe public.orders first (fitter is
  // the only path that mints a PENN- reference today) and fall back
  // to checking shop_orders by stripe_session_id only if a future
  // shop-side path starts emitting the same reference shape.
  const { data: legacyRow, error: legacyErr } = await supabase
    .schema("public")
    .from("orders")
    .select(
      "order_reference, patient_email, mask_name, mask_manufacturer, email_status, email_delivered_at, created_at",
    )
    .eq("order_reference", normalizedRef)
    .limit(1)
    .maybeSingle();
  if (legacyErr) {
    req.log?.warn?.(
      { err: legacyErr.message },
      "orders.track: legacy read failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }

  // Treat "found but email doesn't match" the same as "not found"
  // so an attacker who guesses a reference can't infer which email
  // it belongs to.
  if (
    !legacyRow ||
    (legacyRow.patient_email ?? "").toLowerCase() !== parsed.data.email
  ) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Counts-only log — never the reference or the email.
  req.log?.info?.(
    { event: "orders.track.served", emailStatus: legacyRow.email_status },
    "orders.track: order surfaced",
  );

  res.json({
    orderReference: legacyRow.order_reference,
    mask: {
      name: legacyRow.mask_name,
      manufacturer: legacyRow.mask_manufacturer,
    },
    createdAt: legacyRow.created_at,
    emailStatus: legacyRow.email_status,
    emailDeliveredAt: legacyRow.email_delivered_at,
    // Future expansion: shop_orders linkage for shipped/delivered
    // timestamps + tracking carrier/number. Today public.orders
    // doesn't store fulfillment-side state.
  });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest runs.
export function _resetTrackOrderRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
