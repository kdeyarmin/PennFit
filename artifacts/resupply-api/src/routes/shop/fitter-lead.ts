// POST /shop/fitter-leads — public endpoint for the email +
// marketing-consent capture on the /consent page in cpap-fitter.
//
// What it does:
//   * Validates the body (email + marketingOptIn).
//   * Trips a honeypot — bots fill every input; humans never see the
//     `website` field, so a non-empty value short-circuits with a
//     fake 200.
//   * Rate-limits per sender IP (3 submits / 15 min) so a bot that
//     guessed the URL can't generate unbounded rows.
//   * Best-effort persists to `resupply.fitter_leads`. The patient
//     advances into /capture immediately on the client side, so a
//     DB hiccup must never turn into a 5xx the patient sees.
//
// What it does NOT do:
//   * No email send. The order page later collects all the order PII
//     and fires the confirmation flow; this row just records the
//     opt-in for the abandoned-flow re-engagement dispatcher.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { recordFitterLead } from "../../lib/fitter-lead-record";

const router: IRouter = Router();

// Loose US-phone normalizer. We accept any input the user typed,
// strip non-digits, and only accept the 10-digit (US) or 11-digit
// (1 + 10 US) shapes. Anything else is rejected at the field level
// rather than persisted, so downstream SMS sends never see garbage.
function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const leadBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    marketingOptIn: z.boolean(),
    /**
     * Optional phone. Accepted in any US format ("(555) 123-4567",
     * "5551234567", "1-555-123-4567"). Anything that doesn't normalize
     * to a 10- or 11-digit US number is dropped silently — the lead
     * still records by email; we just don't get an SMS channel.
     */
    phone: z
      .string()
      .trim()
      .max(40)
      .optional()
      .transform((v) => (v ? normalizeUsPhone(v) : null)),
    /**
     * SMS opt-in. Only takes effect when phone normalized to non-null;
     * the helper enforces this so a checkbox tick without a valid
     * phone can't slip through as "subscribed to nothing in particular."
     */
    smsOptIn: z.boolean().optional(),
    /** Honeypot. Real users never fill this. */
    website: z.string().max(200).optional(),
  })
  .strict();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;
const rateBucket = new Map<string, number[]>();
// Sweep every N requests to drop fully-expired buckets so the map
// can't grow unbounded over time on a public endpoint. The sweep is
// O(map size); at the volumes this endpoint sees (a public lead-
// capture form), a sweep every 200 calls is cheap. Without it, every
// distinct sender IP leaves a permanent entry in the map.
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

router.post("/shop/fitter-leads", async (req, res) => {
  const parse = leadBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parse.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const data = parse.data;

  // The frontend will only call this endpoint after the patient
  // explicitly checks "I agree to receive emails from PennPaps", so
  // an explicit opt-OUT here means the request came from outside the
  // expected flow. Reject loudly rather than silently storing a row
  // with marketing_opt_in=false (which the re-engagement dispatcher
  // would then skip anyway).
  if (!data.marketingOptIn) {
    res.status(400).json({ error: "marketing_opt_in_required" });
    return;
  }

  // Honeypot — bots that filled `website` get a fake success.
  if (data.website && data.website.trim().length > 0) {
    req.log?.info?.({ honeypot: true }, "shop/fitter-leads: honeypot trip");
    res.json({ ok: true });
    return;
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  const ipKey = ip + ":fitter-lead";
  if (rateLimited(ipKey)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const persisted = await recordFitterLead({
    email: data.email,
    marketingOptIn: data.marketingOptIn,
    submitterIp: ip === "unknown" ? null : ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null,
    phoneE164: data.phone,
    smsOptIn: data.smsOptIn ?? false,
    // Default 'consent' is applied by the helper; explicit here for
    // self-documentation against future quiz/insurance lead routes
    // that reuse the same helper.
    source: "consent",
  });

  // Counts-only log — never the patient's email.
  req.log?.info?.(
    {
      persisted: persisted.id !== null,
      persistErr: persisted.error,
    },
    "shop/fitter-leads: submission processed",
  );

  res.json({ ok: true });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest
// runs so a 429 from one test doesn't leak into the next.
export function _resetFitterLeadRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
