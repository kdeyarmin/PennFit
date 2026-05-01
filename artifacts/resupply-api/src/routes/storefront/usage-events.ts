/**
 * Anonymous funnel-tracking endpoint.
 *
 * Public (no auth). Rate-limited at the app level. Stores: session_id,
 * step name, optional metadata, timestamp. NEVER stores: IP, user agent,
 * patient identity, or anything from the request body that wasn't
 * explicitly listed in the zod schema below.
 */

import { Router } from "express";
import { z } from "zod";
import { db, usageEventsTable } from "../../lib/storefront/db.js";
import { logger } from "../../lib/logger.js";

const router = Router();

const KNOWN_STEPS = [
  "home_view",
  "consent_given",
  "capture_started",
  "capture_taken",
  "measurements_extracted",
  "questionnaire_completed",
  "results_viewed",
  "mask_chosen",
  "order_started",
  "order_submitted_success",
] as const;

const usageEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  step: z.enum(KNOWN_STEPS),
  metadata: z.string().max(500).optional(),
});

router.post("/usage-events", async (req, res) => {
  const parsed = usageEventSchema.safeParse(req.body);
  if (!parsed.success) {
    // Tracking failures should never block the user. Return 204 even on
    // validation error so a misconfigured client doesn't surface UX errors.
    res.status(204).end();
    return;
  }
  try {
    await db.insert(usageEventsTable).values({
      sessionId: parsed.data.sessionId,
      step: parsed.data.step,
      metadata: parsed.data.metadata ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to insert usage event (ignored)");
  }
  res.status(204).end();
});

export default router;
