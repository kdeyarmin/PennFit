// POST /api/me/sleep-coach
//
// Patient-portal-scoped sleep coach LLM endpoint. The patient must
// be logged in (the storefront auth session resolves a customer_id
// which we map to a patient via the email-link in shop_customers).
//
// Per-IP rate limit applied at the storefront router level keeps
// abuse from running up the OpenAI bill. PHI containment posture +
// prompt details live in lib/clinical/sleep-coach.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { askSleepCoach } from "../../lib/clinical/sleep-coach";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

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

router.post("/me/sleep-coach", async (req, res) => {
  // The storefront `requireAuthenticatedShopper` middleware (mounted
  // up-tree) sets req.shopCustomerId on success; if it didn't run
  // for any reason, bail. This is mirror of the pattern used by
  // /me/orders + /me/reorder-suggestions in storefront/index.ts.
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
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
    logger.warn(
      { err: result.errorMessage },
      "sleep-coach: empty reply",
    );
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
