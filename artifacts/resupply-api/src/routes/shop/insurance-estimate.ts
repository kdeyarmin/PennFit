// POST /shop/insurance-estimates — public lightweight coverage check.
//
// Why a separate route from /shop/insurance-leads
// -----------------------------------------------
// /shop/insurance-leads is the high-commitment form: it asks the
// patient for full name, DOB, phone, member id, group number, and
// prescribing physician — everything the verifications team needs
// to run an actual eligibility check. That form is intentionally
// heavy because it's verification-grade input.
//
// /shop/insurance-estimates is the opposite: payer dropdown + email.
// It's a 30-second top-of-funnel capture for the patient who is
// just researching ("will my insurance cover this?") and isn't
// ready to hand over PHI. We give them a conservative range from
// the static payer table, capture them as a fitter_leads row with
// source='insurance_quote', and email them a written record they
// can share. The next step (CTAs in the email + on the result
// card) is either /consent (the camera fitting) or the full
// /insurance form.
//
// Honeypot + per-IP rate limit follow the same pattern as the other
// public lead-capture routes.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  PAYER_SLUGS,
  findPayerEstimate,
} from "../../lib/insurance-estimates/data";
import { recordFitterLead } from "../../lib/fitter-lead-record";
import { sendInsuranceEstimateEmail } from "../../lib/order-emails/send-insurance-estimate-email";

const router: IRouter = Router();

/**
 * Only surface a LEARNED range once it rests on a robust sample — below
 * this we show the conservative static range instead. (The worker only
 * writes a slug at >=10 samples; this is a stricter public-display bar.)
 */
const LEARNED_DISPLAY_MIN_SAMPLE = 20;

interface LearnedEstimate {
  typicalDollars: number;
  upToDollars: number;
  sampleSize: number;
}

/**
 * Read the precomputed learned OOP stat for a payer slug. Fail-soft:
 * any error (incl. the table not existing pre-0230) → null, so the
 * route always degrades to the static estimate.
 */
async function fetchLearnedEstimate(
  slug: string,
): Promise<LearnedEstimate | null> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("payer_estimate_stats")
      .select("p50_cents, p90_cents, sample_size")
      .eq("slug", slug)
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    if ((data.sample_size ?? 0) < LEARNED_DISPLAY_MIN_SAMPLE) return null;
    return {
      typicalDollars: Math.round(data.p50_cents / 100),
      upToDollars: Math.round(data.p90_cents / 100),
      sampleSize: data.sample_size,
    };
  } catch {
    return null;
  }
}

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;
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
    email: z.string().trim().toLowerCase().email().max(200),
    /** Slug from PAYER_ESTIMATES. */
    payerSlug: z.enum(PAYER_SLUGS as unknown as [string, ...string[]]),
    /** US 5-digit ZIP, optional. Persisted with the lead for triage. */
    zip: z
      .string()
      .trim()
      .max(10)
      .regex(/^\d{5}(-\d{4})?$/, "must be a 5-digit US ZIP")
      .optional(),
    /**
     * Optional marketing opt-in. Default false — receiving your own
     * estimate is transactional, not marketing.
     */
    marketingOptIn: z.boolean().optional().default(false),
    /** Honeypot. Real users never fill this. */
    website: z.string().max(200).optional(),
  })
  .strict();

router.post("/shop/insurance-estimates", async (req, res) => {
  const parse = body.safeParse(req.body);
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

  // Honeypot — bots that filled `website` get a fake success.
  if (data.website && data.website.trim().length > 0) {
    req.log?.info?.(
      { honeypot: true },
      "shop/insurance-estimates: honeypot trip",
    );
    res.json({ ok: true });
    return;
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  const ipKey = ip + ":insurance-estimate";
  if (rateLimited(ipKey)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const estimate = findPayerEstimate(data.payerSlug);

  // Persist the lead first so a SendGrid outage doesn't lose the
  // attribution. source='insurance_quote' so the abandoned-flow
  // re-engagement dispatcher can run a separate copy for this cohort.
  const persisted = await recordFitterLead({
    email: data.email,
    marketingOptIn: data.marketingOptIn,
    submitterIp: ip === "unknown" ? null : ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null,
    source: "insurance_quote",
  });

  // Counts-only log — never the patient's email.
  req.log?.info?.(
    {
      persisted: persisted.id !== null,
      persistErr: persisted.error,
      payerSlug: estimate.slug,
      marketingOptIn: data.marketingOptIn,
      zipKnown: Boolean(data.zip),
    },
    "shop/insurance-estimates: submission processed",
  );

  // Fire-and-forget the estimate email so SendGrid latency doesn't
  // hold the response. The patient sees the inline range result
  // card on the page instantly; the email arrives a beat later
  // as the written record.
  void (async () => {
    try {
      const result = await sendInsuranceEstimateEmail({
        toEmail: data.email,
        estimate,
        zip: data.zip ?? null,
      });
      if (!result.configured) {
        req.log?.info?.(
          { event: "insurance-estimate-email.skipped" },
          "shop/insurance-estimates: sendgrid not configured",
        );
      } else if (!result.delivered) {
        req.log?.warn?.(
          { event: "insurance-estimate-email.failed", err: result.error },
          "shop/insurance-estimates: results email send failed",
        );
      }
    } catch (err) {
      req.log?.warn?.(
        {
          event: "insurance-estimate-email.threw",
          err,
        },
        "shop/insurance-estimates: estimate email send threw (non-fatal)",
      );
    }
  })();

  // A data-derived range from our own adjudicated claims, when we have
  // enough of them for this payer. The page shows it alongside the
  // static range; the email stays on the conservative static numbers.
  const learned = await fetchLearnedEstimate(estimate.slug);

  // Return the canonical range so the page renders the same numbers
  // we just emailed — avoids any drift between the on-page result
  // and the email body.
  res.json({
    ok: true,
    estimate: {
      slug: estimate.slug,
      label: estimate.label,
      lowDollars: estimate.postDeductibleLowDollars,
      highDollars: estimate.postDeductibleHighDollars,
      note: estimate.note,
    },
    learned,
  });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest runs.
export function _resetInsuranceEstimateRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
