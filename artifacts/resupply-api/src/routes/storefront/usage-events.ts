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
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { logger } from "../../lib/logger.js";

const router = Router();

// Must stay in sync with the client-side `TrackStep` union in
// artifacts/cpap-fitter/src/lib/track.ts. The ingest silently drops
// (204) any step not in this list, so a step the client emits but the
// server doesn't allow-list is never persisted — which is exactly how
// the shop-checkout and fitter-invite steps went unrecorded until they
// were added here. The `step` column is free text, so widening this list
// needs no migration.
const KNOWN_STEPS = [
  // Fitter funnel
  "home_view",
  "consent_given",
  "capture_started",
  "capture_taken",
  "measurements_extracted",
  "measurement_error",
  "questionnaire_completed",
  "results_viewed",
  "mask_chosen",
  "order_started",
  "order_submitted_success",
  "capture_blocked",
  "results_retake_requested",
  // Shop / checkout funnel
  "cart_items_dropped",
  "checkout_started",
  "checkout_step_viewed",
  "checkout_error",
  "checkout_completed",
  "reorder_prefill_applied",
  // Fitter-invite (staff-initiated) funnel
  "fitter_invite_opened",
  "fitter_invite_started",
  "fitter_lead_submit_failed",
  // PennBot chat surface (anonymous, no PHI). Helps the team see if
  // the chatbot is being used and which response paths fire.
  "chat_opened",
  "chat_sent",
  "chat_replied",
  "chat_feedback",
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
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("public")
      .from("usage_events")
      .insert({
        session_id: parsed.data.sessionId,
        step: parsed.data.step,
        metadata: parsed.data.metadata ?? null,
      });
    if (error) throw error;
  } catch (err) {
    logger.warn({ err }, "Failed to insert usage event (ignored)");
  }
  res.status(204).end();
});

export default router;
