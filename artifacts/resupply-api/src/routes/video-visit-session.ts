// /video-visit/session — public, token-gated lookup the patient join
// page calls before entering a telehealth video visit.
//
// The token is the HMAC-signed link from the SMS/email invite (or the
// short-lived staff token); no admin session is required. The response
// deliberately carries NO patient PHI — anyone holding the link learns
// only the practice name, the visit purpose, and the scheduled time.
// Determinate non-joinable states (cancelled / completed) come back as
// 200 + state so the SPA can render a friendly explanation instead of
// an error page.

import { Router, type IRouter } from "express";
import expressRateLimit from "express-rate-limit";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isFeatureEnabled } from "../lib/feature-flags";
import { readPracticeName } from "../lib/messaging/messaging-config";
import { getIceServers } from "../lib/video/ice-servers";
import { verifyVideoVisitToken } from "../lib/video/video-visit-token";

const router: IRouter = Router();

const VIDEO_SIGNAL_WS_PATH = "/resupply-api/video/signal";

// Public endpoint — per-IP cap keeps token brute-forcing and refresh
// loops cheap to absorb. The HMAC makes guessing cryptographically
// hopeless anyway; this is belt-and-braces.
const sessionLimiter = expressRateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

router.get("/video-visit/session", sessionLimiter, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  let verified: ReturnType<typeof verifyVideoVisitToken>;
  try {
    verified = verifyVideoVisitToken(token);
  } catch {
    // RESUPPLY_LINK_HMAC_KEY unset in this environment.
    res.status(503).json({ state: "disabled" });
    return;
  }
  if (!verified.valid) {
    res.status(404).json({ state: "invalid" });
    return;
  }
  if (!(await isFeatureEnabled("telehealth.video"))) {
    res.status(503).json({ state: "disabled" });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: visit, error } = await supabase
    .schema("resupply")
    .from("video_visits")
    .select("id, status, purpose, scheduled_at, link_version")
    .eq("id", verified.visitId)
    .maybeSingle();
  if (error) throw error;
  if (!visit || visit.link_version !== verified.linkVersion) {
    res.status(404).json({ state: "invalid" });
    return;
  }
  if (visit.status === "cancelled" || visit.status === "completed") {
    res.json({ state: visit.status });
    return;
  }

  res.json({
    state: "ready",
    role: verified.role,
    purpose: visit.purpose,
    scheduledAt: visit.scheduled_at,
    practiceName: readPracticeName(),
    wsPath: VIDEO_SIGNAL_WS_PATH,
    iceServers: getIceServers(),
  });
});

export default router;
