// POST /api/me/sleep-coach
//
// Patient-portal-scoped sleep coach LLM endpoint. The patient must
// be logged in (the storefront auth session resolves a customer_id
// which we map to a patient via the email-link in shop_customers).
//
// Per-customer rate limit (defined below, IP fallback) keeps a
// compromised or scripted session from running up the vendor bill —
// every accepted request burns Anthropic / OpenAI tokens. PHI
// containment posture + prompt details live in
// lib/clinical/sleep-coach.ts.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { askSleepCoach } from "../../lib/clinical/sleep-coach";
import { RATE_LIMITS } from "../../lib/rate-limits-config";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

// Keyed by the signed-in customer id when present (so one session
// can't burn the whole IP's quota for everyone behind shared NAT),
// falling back to IP for unauthenticated callers — who get 401'd in
// the handler anyway, so the fallback only matters as a flood shield.
const sleepCoachLimiter = expressRateLimit({
  windowMs: RATE_LIMITS.me_sleep_coach.windowMs,
  limit: RATE_LIMITS.me_sleep_coach.limit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const customerId = req.shopCustomerId;
    if (typeof customerId === "string" && customerId.length > 0) {
      return `sleep-coach:${customerId}`;
    }
    return ipKeyGenerator(req.ip ?? "0.0.0.0");
  },
  message: {
    error: "coach_rate_limited",
    message:
      "You're sending messages too quickly. Please wait a minute and try again.",
  },
});

const body = z
  .object({
    question: z.string().trim().min(2).max(1000),
    thread: z
      .array(
        z.object({
          role: z.enum(["patient", "coach"]),
          body: z.string().trim().max(2000),
        }),
      )
      .max(20)
      .optional(),
  })
  .strict();

router.post("/me/sleep-coach", sleepCoachLimiter, async (req, res) => {
  // The storefront `attachSignedIn` middleware (mounted up-tree in
  // routes/storefront/index.ts) sets req.shopCustomerId from the
  // pf_session cookie; if the request isn't signed in it's absent, so
  // we bail with 401.
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: customer } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (!customer?.email_lower) {
    res.status(404).json({ error: "no_linked_patient" });
    return;
  }
  // Best-effort patient lookup by email match. Case-insensitive
  // (ilike + escaped meta-chars) so legacy mixed-case patient.email
  // rows still resolve; .limit(2) + length !== 1 refuses the
  // ambiguous case rather than serving the sleep-coach memory of
  // a different patient who shares the email.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (!patients || patients.length !== 1) {
    res.status(404).json({ error: "no_linked_patient" });
    return;
  }
  const patient = patients[0]!;
  const result = await askSleepCoach({
    patientId: patient.id,
    question: parsed.data.question,
    thread: parsed.data.thread,
  });
  if (!result.reply) {
    logger.warn({ err: result.errorMessage }, "sleep-coach: empty reply");
    res.status(503).json({
      error: "coach_unavailable",
      message:
        "The sleep coach is temporarily unavailable. Please try again in a few minutes or call our team.",
    });
    return;
  }
  res.json({
    reply: result.reply,
    latencyMs: result.latencyMs,
  });
});

export default router;
