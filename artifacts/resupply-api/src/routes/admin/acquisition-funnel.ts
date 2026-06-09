// /admin/analytics/acquisition-funnel — storefront/fitter acquisition
// funnel drop-off, from the anonymous public.usage_events stream.
//
//   GET /admin/analytics/acquisition-funnel?days=30
//
// Surfacing half of Growth #G1. The customer SPA already posts ~25 typed
// funnel steps to /api/usage-events (see lib/track.ts + routes/storefront/
// usage-events.ts); until now nothing read them. This route runs the
// acquisition_funnel_steps RPC (mig 0254 — per-step distinct-session +
// event counts over a window) and arranges the steps into two ordered
// funnels (the at-home fitter flow and the shop checkout flow), computing
// step-to-step and top-of-funnel conversion so the team can see WHERE
// patients drop out.
//
// Anonymous by construction — usage_events stores only a per-tab random
// session id, never patient identity. reports.read-gated, matching the
// rest of the analytics surface.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Ordered funnel definitions. Each entry is the step name (as emitted by
// the client) plus a human label. Order is the intended sequence; the
// route computes conversion relative to the previous stage and the top.
const FITTER_FUNNEL: ReadonlyArray<{ step: string; label: string }> = [
  { step: "home_view", label: "Home view" },
  { step: "consent_given", label: "Consent given" },
  { step: "capture_taken", label: "Photo captured" },
  { step: "measurements_extracted", label: "Measurements extracted" },
  { step: "questionnaire_completed", label: "Questionnaire completed" },
  { step: "results_viewed", label: "Results viewed" },
  { step: "mask_chosen", label: "Mask chosen" },
  { step: "order_started", label: "Order started" },
  { step: "order_submitted_success", label: "Order submitted" },
];

const CHECKOUT_FUNNEL: ReadonlyArray<{ step: string; label: string }> = [
  { step: "checkout_started", label: "Checkout started" },
  { step: "checkout_step_viewed", label: "Checkout step viewed" },
  { step: "checkout_completed", label: "Checkout completed" },
];

// Non-sequential signals worth surfacing as raw event counts (friction /
// error markers, not funnel stages).
const SIGNAL_STEPS: ReadonlyArray<{ step: string; label: string }> = [
  { step: "measurement_error", label: "Measurement errors" },
  { step: "capture_blocked", label: "Camera blocked" },
  { step: "results_retake_requested", label: "Retake requested" },
  { step: "cart_items_dropped", label: "Cart items dropped" },
  { step: "checkout_error", label: "Checkout errors" },
];

interface FunnelStepRow {
  step: string;
  sessions: number;
  events: number;
}

export interface FunnelStage {
  step: string;
  label: string;
  sessions: number;
  events: number;
  /** sessions ÷ previous stage sessions; null for the first stage. */
  conversionFromPrev: number | null;
  /** sessions ÷ first stage sessions; null when the top is empty. */
  conversionFromTop: number | null;
}

export interface FunnelSummary {
  stages: FunnelStage[];
  topSessions: number;
  /** last stage sessions ÷ first stage sessions; null when top is empty. */
  overallConversion: number | null;
}

const querySchema = z
  .object({ days: z.coerce.number().int().min(1).max(365).optional() })
  .strict();

/** Pure: arrange raw per-step counts into an ordered funnel with conversion. */
export function buildFunnel(
  definition: ReadonlyArray<{ step: string; label: string }>,
  byStep: Map<string, FunnelStepRow>,
): FunnelSummary {
  const stages: FunnelStage[] = [];
  let topSessions = 0;
  let prevSessions: number | null = null;
  for (let i = 0; i < definition.length; i++) {
    const def = definition[i];
    const row = byStep.get(def.step);
    const sessions = row?.sessions ?? 0;
    const events = row?.events ?? 0;
    if (i === 0) topSessions = sessions;
    stages.push({
      step: def.step,
      label: def.label,
      sessions,
      events,
      conversionFromPrev:
        prevSessions != null && prevSessions > 0
          ? sessions / prevSessions
          : null,
      conversionFromTop: topSessions > 0 ? sessions / topSessions : null,
    });
    prevSessions = sessions;
  }
  const last = stages[stages.length - 1];
  return {
    stages,
    topSessions,
    overallConversion:
      topSessions > 0 && last ? last.sessions / topSessions : null,
  };
}

router.get(
  "/admin/analytics/acquisition-funnel",
  // Rate-limited so CodeQL's js/missing-rate-limiting gate is satisfied
  // and the DB-backed analytics read can't be hammered.
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days ?? 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86400_000);

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("acquisition_funnel_steps", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
    if (error) throw error;

    const rows = (Array.isArray(data) ? data : []) as Array<{
      step: string;
      sessions: number | string;
      events: number | string;
    }>;
    const byStep = new Map<string, FunnelStepRow>();
    for (const r of rows) {
      byStep.set(r.step, {
        step: r.step,
        sessions: Number(r.sessions) || 0,
        events: Number(r.events) || 0,
      });
    }

    res.json({
      window: { from: from.toISOString(), to: to.toISOString(), days },
      fitter: buildFunnel(FITTER_FUNNEL, byStep),
      checkout: buildFunnel(CHECKOUT_FUNNEL, byStep),
      signals: SIGNAL_STEPS.map((s) => ({
        step: s.step,
        label: s.label,
        events: byStep.get(s.step)?.events ?? 0,
      })),
    });
  },
);

export default router;
