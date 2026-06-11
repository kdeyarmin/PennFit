// POST /shop/quiz-leads — public endpoint for the sleep-apnea quiz
// email capture on /learn/sleep-apnea-quiz.
//
// What it does
// ------------
// The patient has just completed the STOP-BANG quiz and clicked
// "email me my results." We:
//
//   1. Validate the body (email + score + band + optional symptoms +
//      optional marketingOptIn).
//   2. Trip a honeypot (the `website` field).
//   3. Rate-limit per sender IP (3 submits / 15 min) — same posture
//      as /shop/fitter-leads.
//   4. Best-effort persist a fitter_leads row with
//      source='sleep_apnea_quiz'. The marketing_opt_in column
//      mirrors the patient's checkbox; the row is recorded either
//      way so the abandoned-flow / lead-attribution analytics
//      remain complete.
//   5. Fire-and-forget the transactional "your quiz results" email.
//      Under CAN-SPAM / GDPR the patient asked us to send the
//      document, so it does NOT require the marketing opt-in.
//
// The patient sees a 200 the moment the row is staged; DB and
// SendGrid failures never 5xx the response.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { recordFitterLead } from "../../lib/fitter-lead-record";
import {
  sendQuizResultsEmail,
  type QuizRiskBand,
} from "../../lib/order-emails/send-quiz-results-email";

const router: IRouter = Router();

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

/**
 * Compute the risk band from a STOP-BANG score.
 * Score 0-2: low, 3-4: intermediate, 5-8: high.
 */
function computeBand(score: number): "low" | "intermediate" | "high" {
  if (score <= 2) return "low";
  if (score <= 4) return "intermediate";
  return "high";
}

const body = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    /** STOP-BANG 0..8. */
    score: z.number().int().min(0).max(8),
    /**
     * Plain-text labels of the symptoms the patient answered "yes" to.
     * The frontend provides these so the email can list them back to
     * the patient — saves them re-deriving from the score alone.
     */
    symptoms: z.array(z.string().trim().max(120)).max(20).optional(),
    /**
     * Did the patient ALSO tick "send me product news / fitting follow-ups"?
     * Independent of the results-email request. False is the default —
     * receiving your own quiz results is transactional, not marketing.
     */
    marketingOptIn: z.boolean().optional().default(false),
    /** Honeypot. Real users never fill this. */
    website: z.string().max(200).optional(),
  })
  .strict();

router.post("/shop/quiz-leads", async (req, res) => {
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
    req.log?.info?.({ honeypot: true }, "shop/quiz-leads: honeypot trip");
    res.json({ ok: true });
    return;
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    "unknown";
  const ipKey = ip + ":quiz-lead";
  if (rateLimited(ipKey)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  // Compute the authoritative band server-side from the score.
  const computedBand = computeBand(data.score);

  // Persist the row first so the lead is durable even if SendGrid
  // is unconfigured / down.
  const persisted = await recordFitterLead({
    email: data.email,
    marketingOptIn: data.marketingOptIn,
    submitterIp: ip === "unknown" ? null : ip,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"].slice(0, 500)
        : null,
    source: "sleep_apnea_quiz",
  });

  // Counts-only log — never the patient's email.
  req.log?.info?.(
    {
      persisted: persisted.id !== null,
      persistErr: persisted.error,
      score: data.score,
      band: computedBand,
      marketingOptIn: data.marketingOptIn,
    },
    "shop/quiz-leads: submission processed",
  );

  // Transactional results email. Fire-and-forget against the
  // response so a SendGrid 5xx never blocks the 200. The patient
  // can always re-take the quiz if the email never arrives —
  // it's not a payment-critical workflow.
  void (async () => {
    try {
      const result = await sendQuizResultsEmail({
        toEmail: data.email,
        score: data.score,
        band: computedBand as QuizRiskBand,
        symptoms: data.symptoms,
      });
      if (!result.configured) {
        req.log?.info?.(
          { event: "quiz-results-email.skipped" },
          "shop/quiz-leads: sendgrid not configured",
        );
      } else if (!result.delivered) {
        req.log?.warn?.(
          { event: "quiz-results-email.failed", err: result.error },
          "shop/quiz-leads: results email send failed",
        );
      }
    } catch (err) {
      req.log?.warn?.(
        {
          event: "quiz-results-email.threw",
          err,
        },
        "shop/quiz-leads: results email send threw (non-fatal)",
      );
    }
  })();

  res.json({ ok: true });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest runs.
export function _resetQuizLeadRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
