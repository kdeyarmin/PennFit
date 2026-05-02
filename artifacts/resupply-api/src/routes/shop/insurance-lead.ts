// POST /shop/insurance-leads — public endpoint for the lead-capture
// form on /insurance. Captures the prospect's contact + insurance
// details, fires two SendGrid emails (team notification + patient
// confirmation), and returns 200 on success.
//
// Anti-abuse:
//   * `website` honeypot field — bots fill every input; humans never
//     see this one. If filled we 200 a fake success and skip the
//     SendGrid calls entirely so the bot moves on without retrying.
//   * In-memory token-bucket rate limit keyed by sender IP: 3 submits
//     per 15 minutes is enough headroom for a human who fat-fingered
//     and far below scraper throughput. Cleared on process restart;
//     this is intentional — operations can hot-fix abuse by bouncing
//     the workflow, and we don't need a Redis dependency for a
//     single-form rate limit.
//
// No DB writes today: the team works the email inbox. We log a
// counts-only audit line so we can prove submission volume without
// exposing PHI in the audit table.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { sendInsuranceLeadEmails } from "../../lib/insurance-lead-email";

const router: IRouter = Router();

const leadBody = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    // Lightweight email shape — the email provider does the real
    // deliverability check. We just want to reject obvious nonsense.
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().min(7).max(40),
    dateOfBirth: z.string().trim().min(4).max(40),
    insuranceCarrier: z.string().trim().min(2).max(120),
    memberId: z.string().trim().min(2).max(80),
    groupNumber: z
      .string()
      .trim()
      .max(80)
      .nullish()
      .transform((v) => (v ? v : null)),
    prescribingPhysician: z
      .string()
      .trim()
      .max(120)
      .nullish()
      .transform((v) => (v ? v : null)),
    notes: z
      .string()
      .trim()
      .max(1000)
      .nullish()
      .transform((v) => (v ? v : null)),
    /** Honeypot. Real users never fill this. */
    website: z.string().max(200).optional(),
  })
  .strict();

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 3;
const rateBucket = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
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

router.post("/shop/insurance-leads", async (req, res) => {
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

  // Honeypot — bots that filled `website` get a fake success.
  if (data.website && data.website.trim().length > 0) {
    req.log?.info?.({ honeypot: true }, "shop/insurance-leads: honeypot trip");
    res.json({ ok: true });
    return;
  }

  const ipKey =
    (req.ip ||
      req.socket?.remoteAddress ||
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      "unknown") + ":insurance-lead";
  if (rateLimited(ipKey)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const result = await sendInsuranceLeadEmails({
    fullName: data.fullName,
    email: data.email,
    phone: data.phone,
    dateOfBirth: data.dateOfBirth,
    insuranceCarrier: data.insuranceCarrier,
    memberId: data.memberId,
    groupNumber: data.groupNumber,
    prescribingPhysician: data.prescribingPhysician,
    notes: data.notes,
  });

  // Counts-only log — never the patient's PHI.
  req.log?.info?.(
    {
      configured: result.configured,
      notificationDelivered: result.notificationDelivered,
      confirmationDelivered: result.confirmationDelivered,
      err: result.error,
    },
    "shop/insurance-leads: submission processed",
  );

  // Always 200 to the user once validation + rate limit pass — even
  // when SendGrid is misconfigured or transient-failed. The team
  // recovers from logs/inbox; we never want a patient to see
  // "something went wrong" after they trustingly typed a member ID.
  res.json({
    ok: true,
    delivered:
      result.notificationDelivered || result.confirmationDelivered,
  });
});

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest
// runs so a 429 from one test doesn't leak into the next.
export function _resetInsuranceLeadRateBucketForTests(): void {
  rateBucket.clear();
}
